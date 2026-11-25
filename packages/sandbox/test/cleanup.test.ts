import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  CACHE_VOLUMES,
  cacheVolumes,
  DEFAULT_POLICY,
  dockerBytes,
  heldSandboxes,
  holdSandbox,
  isCacheVolume,
  KEEP_GRACE_MS,
  limitFlags,
  limitsFromEnv,
  needsServices,
  parseBytes,
  parseDuration,
  planSweep,
  policyFromEnv,
  type SandboxInfo,
  sandboxRuntime,
} from "../src/cleanup.ts"

const HOUR = 3_600_000
const NOW = Date.parse("2026-11-18T12:00:00Z")

function box(run: string, running: boolean, hoursAgo: number): SandboxInfo {
  return {
    run,
    container: `pr2video-${run}`,
    running,
    image: "pr2video-sandbox:abc",
    createdAt: new Date(NOW - 100 * HOUR),
    lastUsed: new Date(NOW - hoursAgo * HOUR),
  }
}

describe("the policy's settings", () => {
  it("reads durations, sizes and off", () => {
    expect(parseDuration("30m", "x")).toBe(30 * 60_000)
    expect(parseDuration("2h", "x")).toBe(2 * HOUR)
    expect(parseDuration("1.5d", "x")).toBe(36 * HOUR)
    expect(parseDuration("off", "x")).toBeNull()
    expect(parseDuration("0", "x")).toBeNull()
    expect(() => parseDuration("3", "PR2VIDEO_SANDBOX_TTL")).toThrow(/PR2VIDEO_SANDBOX_TTL/)
    expect(parseBytes("10g", "x")).toBe(10e9)
    expect(parseBytes("500MB", "x")).toBe(500e6)
    expect(parseBytes("never", "x")).toBeNull()
    expect(() => parseBytes("lots", "x")).toThrow()
  })

  it("defaults, and takes each variable", () => {
    expect(policyFromEnv({})).toEqual(DEFAULT_POLICY)
    expect(
      policyFromEnv({
        PR2VIDEO_SANDBOX_IDLE: "15m",
        PR2VIDEO_SANDBOX_TTL: "off",
        PR2VIDEO_KEEP_SANDBOXES: "0",
        PR2VIDEO_CACHE_MAX: "2g",
      }),
    ).toEqual({ idleMs: 15 * 60_000, ttlMs: null, keep: 0, cacheMaxBytes: 2e9 })
    expect(policyFromEnv({ PR2VIDEO_KEEP_SANDBOXES: "off" }).keep).toBeNull()
    expect(() => policyFromEnv({ PR2VIDEO_KEEP_SANDBOXES: "two" })).toThrow()
  })

  it("reads Docker's sizes", () => {
    expect(dockerBytes("5.77GB (virtual 8.26GB)")).toBeCloseTo(5.77e9)
    expect(dockerBytes("953.5MiB / 36.16GiB")).toBeCloseTo(953.5 * 1024 ** 2)
    expect(dockerBytes("0B")).toBe(0)
    expect(dockerBytes("")).toBeUndefined()
  })
})

describe("planSweep", () => {
  it("puts an unused running sandbox to sleep, and leaves a busy one", () => {
    const actions = planSweep([box("busy", true, 0.2), box("idle", true, 3)], DEFAULT_POLICY, NOW)
    expect(actions).toEqual([
      { kind: "sleep", container: "pr2video-idle", reason: "unused for 3 h" },
    ])
  })

  it("removes one asleep past the TTL", () => {
    const actions = planSweep([box("old", false, 80), box("new", false, 5)], DEFAULT_POLICY, NOW)
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual(["remove pr2video-old"])
  })

  it("keeps the newest few, never removing one in use", () => {
    const list = [
      box("a", true, 0.1),
      box("b", true, 0.2),
      box("c", false, 13),
      box("d", false, 14),
      box("e", true, 0.3),
    ]
    const actions = planSweep(list, { ...DEFAULT_POLICY, keep: 2 }, NOW)
    // a, b and e are in use: only the asleep ones beyond the newest two go.
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual([
      "remove pr2video-c",
      "remove pr2video-d",
    ])
  })

  it("keeps one beyond the newest few until it has been unused for a while", () => {
    const list = [box("a", false, 0.5), box("b", false, 1.5), box("c", false, 30)]
    const actions = planSweep(list, { ...DEFAULT_POLICY, keep: 1 }, NOW)
    expect(KEEP_GRACE_MS).toBe(12 * HOUR)
    // b paused an hour and a half ago (another session, say): it stays.
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual(["remove pr2video-c"])
  })

  it("leaves a sandbox another command is using, whatever its age", () => {
    const list = [box("old", false, 200), box("idle", true, 5), box("other", false, 20)]
    const actions = planSweep(
      list,
      { ...DEFAULT_POLICY, keep: 1 },
      NOW,
      undefined,
      new Set(["pr2video-old", "pr2video-idle"]),
    )
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual(["remove pr2video-other"])
  })

  it("never touches the protected run, and counts it first", () => {
    const list = [box("x", false, 13), box("mine", false, 200)]
    const actions = planSweep(list, { ...DEFAULT_POLICY, keep: 1 }, NOW, "mine")
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual(["remove pr2video-x"])
  })

  it("does nothing with every rule off", () => {
    const off = { idleMs: null, ttlMs: null, keep: null, cacheMaxBytes: null }
    expect(planSweep([box("a", true, 500), box("b", false, 500)], off, NOW)).toEqual([])
  })
})

describe("holding a sandbox", () => {
  it("lists the ones live processes hold, and clears the dead ones' holds", async () => {
    const name = `pr2video-test-hold-${process.pid}-${Date.now()}`
    await holdSandbox(name)
    const dir = join(homedir(), ".cache", "pr2video", "in-use")
    await mkdir(dir, { recursive: true })
    // No process has PID 2^22 + 1 (above every system's limit).
    const dead = `${name}-dead.${2 ** 22 + 1}`
    await writeFile(join(dir, dead), "")
    const held = await heldSandboxes()
    expect(held.has(name)).toBe(true)
    expect(held.has(`${name}-dead`)).toBe(false)
  })
})

describe("sandbox limits", () => {
  it("defaults to 8 GB, half of Docker's CPUs (at least 2) and 8192 processes", () => {
    expect(limitsFromEnv(10, {})).toEqual({ memoryBytes: 8e9, cpus: 5, pids: 8192 })
    expect(limitsFromEnv(2, {}).cpus).toBe(2)
  })

  it("takes settings, and off for each", () => {
    expect(
      limitsFromEnv(8, {
        PR2VIDEO_SANDBOX_MEMORY: "4g",
        PR2VIDEO_SANDBOX_CPUS: "1.5",
        PR2VIDEO_SANDBOX_PIDS: "off",
      }),
    ).toEqual({ memoryBytes: 4e9, cpus: 1.5, pids: null })
    expect(limitsFromEnv(8, { PR2VIDEO_SANDBOX_MEMORY: "off" }).memoryBytes).toBeNull()
    expect(() => limitsFromEnv(8, { PR2VIDEO_SANDBOX_PIDS: "1.5" })).toThrow(/whole number/)
    expect(() => limitsFromEnv(8, { PR2VIDEO_SANDBOX_CPUS: "lots" })).toThrow(/number or off/)
  })

  it("turns them into docker run flags, leaving out a CPU limit Docker cannot give", () => {
    expect(limitFlags({ memoryBytes: 8e9, cpus: 5, pids: 8192 }, 10)).toEqual([
      "--memory",
      "8000000000",
      "--cpus",
      "5",
      "--pids-limit",
      "8192",
    ])
    expect(limitFlags({ memoryBytes: null, cpus: 4, pids: null }, 4)).toEqual([])
  })
})

describe("isolation", () => {
  it("gives a sandbox an engine only for a Compose file", () => {
    for (const file of [
      "compose.yaml",
      "docker-compose.yml",
      "docker-compose.dev.yml",
      "deploy/compose.override.yaml",
    ])
      expect(needsServices(["src/index.ts", file])).toBe(true)
    for (const file of [
      "Dockerfile",
      "src/compose.ts",
      "my-compose.yml",
      "node_modules/x/compose.yml",
    ])
      expect(needsServices([file])).toBe(false)
  })

  it("uses Sysbox where Docker has it, unless told not to", () => {
    expect(sandboxRuntime(["runc"], {})).toBeNull()
    expect(sandboxRuntime(["runc", "sysbox-runc"], {})).toBe("sysbox-runc")
    expect(sandboxRuntime(["runc", "sysbox-runc"], { PR2VIDEO_RUNTIME: "runc" })).toBeNull()
    expect(sandboxRuntime(["runc", "sysbox-runc"], { PR2VIDEO_RUNTIME: "off" })).toBeNull()
    expect(sandboxRuntime(["runc", "my-sysbox"], { PR2VIDEO_RUNTIME: "my-sysbox" })).toBe(
      "my-sysbox",
    )
    expect(() => sandboxRuntime(["runc"], { PR2VIDEO_RUNTIME: "sysbox-runc" })).toThrow(
      /no such runtime/,
    )
  })

  it("shares the caches by default, and gives each project its own on request", () => {
    expect(cacheVolumes("/a", {})).toEqual({ pnpm: CACHE_VOLUMES[0], npm: CACHE_VOLUMES[1] })
    const a = cacheVolumes("/a", { PR2VIDEO_CACHE_SCOPE: "project" })
    const b = cacheVolumes("/b", { PR2VIDEO_CACHE_SCOPE: "project" })
    expect(a.pnpm).toMatch(/^pr2video-pnpm-store-[0-9a-f]{12}$/)
    expect(a).not.toEqual(b)
    expect(cacheVolumes("/a", { PR2VIDEO_CACHE_SCOPE: "project" })).toEqual(a)
    expect(isCacheVolume(a.pnpm) && isCacheVolume(a.npm) && isCacheVolume(CACHE_VOLUMES[0])).toBe(
      true,
    )
    expect(isCacheVolume("pr2video-docker-run1")).toBe(false)
    expect(() => cacheVolumes("/a", { PR2VIDEO_CACHE_SCOPE: "repo" })).toThrow(/shared or project/)
  })
})
