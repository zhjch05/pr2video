import { describe, expect, it } from "vitest"

import {
  DEFAULT_POLICY,
  dockerBytes,
  limitFlags,
  limitsFromEnv,
  parseBytes,
  parseDuration,
  planSweep,
  policyFromEnv,
  type SandboxInfo,
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
      box("c", false, 1),
      box("d", false, 2),
      box("e", true, 0.3),
    ]
    const actions = planSweep(list, { ...DEFAULT_POLICY, keep: 2 }, NOW)
    // a, b and e are in use: only the asleep ones beyond the newest two go.
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual([
      "remove pr2video-c",
      "remove pr2video-d",
    ])
  })

  it("never touches the protected run, and counts it first", () => {
    const list = [box("x", false, 1), box("mine", false, 200)]
    const actions = planSweep(list, { ...DEFAULT_POLICY, keep: 1 }, NOW, "mine")
    expect(actions.map((a) => `${a.kind} ${a.container}`)).toEqual(["remove pr2video-x"])
  })

  it("does nothing with every rule off", () => {
    const off = { idleMs: null, ttlMs: null, keep: null, cacheMaxBytes: null }
    expect(planSweep([box("a", true, 500), box("b", false, 500)], off, NOW)).toEqual([])
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
