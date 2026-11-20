/**
 * A real sandbox against this machine's Docker: opt in with
 * PR2VIDEO_TEST_DOCKER=1. Builds the image the first time (minutes).
 */
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import {
  copyOut,
  docker,
  down,
  engineVolume,
  exec,
  processes,
  readJournal,
  replay,
  resolveRecord,
  type SandboxRecord,
  sandboxes,
  sandboxNetwork,
  sleepContainer,
  start,
  up,
  waitPort,
} from "../src/index.ts"

const enabled = process.env.PR2VIDEO_TEST_DOCKER === "1"

// `up` sweeps by the cleanup policy: never let a test put to sleep or remove
// the sandboxes of whoever runs it.
for (const name of [
  "PR2VIDEO_SANDBOX_IDLE",
  "PR2VIDEO_SANDBOX_TTL",
  "PR2VIDEO_KEEP_SANDBOXES",
  "PR2VIDEO_CACHE_MAX",
])
  process.env[name] = "off"

async function repoWithTwoCommits(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pr2video-repo-"))
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "test")
  await writeFile(join(repo, "index.html"), "<h1>Before</h1>")
  git("add", ".")
  git("commit", "-q", "-m", "base")
  git("checkout", "-q", "-b", "feature")
  await writeFile(join(repo, "index.html"), "<h1>After</h1>")
  git("commit", "-q", "-am", "head")
  return repo
}

describe.runIf(enabled)("sandbox", () => {
  let record: SandboxRecord | null = null
  afterAll(async () => {
    if (record) await down(record)
  })

  it("checks out head and base, runs commands, serves, nests Docker and replays on the base", async () => {
    const repo = await repoWithTwoCommits()
    record = await up({ cwd: repo, base: "main", run: `test-${Date.now().toString(36)}` })
    expect(record.base?.dir).toBe("/work/base")

    const node = await exec(record, "node --version && cat index.html", { record: false })
    expect(node.exitCode).toBe(0)
    expect(node.stdout).toMatch(/^v24\./)
    expect(node.stdout).toContain("After")

    const installed = await exec(record, "echo built > /work/head/build.txt", { record: true })
    expect(installed.exitCode).toBe(0)
    const served = await start(record, "web", "python3 -m http.server 8080", {
      port: 8080,
      record: true,
    })
    expect(served.wait?.ok).toBe(true)
    expect((await processes(record)).find((p) => p.name === "web")?.running).toBe(true)

    const nested = await exec(record, "docker run --rm hello-world", { timeoutMs: 180_000 })
    expect(nested.stdout).toContain("Hello from Docker!")

    expect((await readJournal(record.repo, record.run)).length).toBe(2)
    const replayed = await replay(record)
    expect(replayed.ok).toBe(true)
    const base = await exec(record, "cat index.html build.txt", { cwd: "/work/base" })
    expect(base.stdout).toContain("Before")
    expect(base.stdout).toContain("built")
  }, 900_000)

  it("sleeps, wakes with its services and servers, and down removes its volume", async () => {
    const repo = await repoWithTwoCommits()
    const box = await up({ cwd: repo, base: null, run: `sleep-${Date.now().toString(36)}` })
    try {
      const served = await start(box, "web", "python3 -m http.server 8081", { port: 8081 })
      expect(served.wait?.ok).toBe(true)
      const service = await exec(box, "docker run -d --name svc busybox sleep 600", {
        timeoutMs: 180_000,
      })
      expect(service.exitCode).toBe(0)

      await sleepContainer(box.container)
      const asleep = (await sandboxes()).find((s) => s.container === box.container)
      expect(asleep?.running).toBe(false)
      await expect(resolveRecord(repo, box.run, { wake: false })).rejects.toThrow(/asleep/)

      const lines: Array<string> = []
      await resolveRecord(repo, box.run, { log: (line) => lines.push(line) })
      expect(lines.join("\n")).toMatch(/started web again: HTTP 200/)
      expect((await waitPort(box, 8081, { timeoutMs: 10_000 })).ok).toBe(true)
      const inner = await exec(box, "docker inspect -f '{{.State.Running}}' svc")
      expect(inner.stdout.trim()).toBe("true")
    } finally {
      await down(box)
    }
    expect((await docker(["volume", "inspect", engineVolume(box.run)])).code).not.toBe(0)
  }, 900_000)

  it("copies a folder without git as it is, leaving out dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-folder-"))
    await writeFile(join(dir, "index.html"), "<h1>Folder</h1>")
    await mkdir(join(dir, "node_modules/left-out"), { recursive: true })
    await writeFile(join(dir, "node_modules/left-out/index.js"), "")
    const folder = await up({ cwd: dir, run: `test-folder-${Date.now().toString(36)}` })
    try {
      expect(folder.head.folder).toBe(true)
      expect(folder.base).toBeNull()
      const seen = await exec(folder, "cat index.html; ls; git log --oneline | wc -l")
      expect(seen.stdout).toContain("<h1>Folder</h1>")
      expect(seen.stdout).not.toContain("node_modules")
      expect(seen.stdout.trim().split("\n").at(-1)?.trim()).toBe("1")
    } finally {
      await down(folder)
    }
  }, 600_000)

  it("with --folder in git, takes uncommitted and untracked files, not ignored ones, and a base on request", async () => {
    const repo = await repoWithTwoCommits()
    await writeFile(join(repo, "index.html"), "<h1>Uncommitted</h1>")
    await writeFile(join(repo, "new.txt"), "untracked")
    await writeFile(join(repo, ".gitignore"), "secret.env\n")
    await writeFile(join(repo, "secret.env"), "KEY=1")
    const folder = await up({
      cwd: repo,
      folder: true,
      base: "main",
      run: `test-gitfolder-${Date.now().toString(36)}`,
    })
    try {
      expect(folder.head.folder).toBe(true)
      expect(folder.base?.ref).toBe("main")
      const seen = await exec(folder, "cat index.html new.txt; ls -a")
      expect(seen.stdout).toContain("Uncommitted")
      expect(seen.stdout).toContain("untracked")
      expect(seen.stdout).not.toContain("secret.env")
      const base = await exec(folder, "cat index.html", { cwd: "/work/base" })
      expect(base.stdout).toContain("Before")
    } finally {
      await down(folder)
    }
  }, 600_000)

  it("mounts nothing of the host, is limited, and cannot reach another sandbox", async () => {
    const repo = await repoWithTwoCommits()
    const a = await up({ cwd: repo, base: "main", run: `test-guard-a-${Date.now().toString(36)}` })
    const b = await up({ cwd: repo, base: null, run: `test-guard-b-${Date.now().toString(36)}` })
    try {
      const [info] = JSON.parse((await docker(["inspect", a.container])).stdout) as Array<{
        Mounts: Array<{ Type: string }>
        HostConfig: { Memory: number; PidsLimit: number; NetworkMode: string }
      }>
      expect(info?.Mounts.filter((m) => m.Type === "bind")).toEqual([])
      expect(info?.HostConfig.Memory).toBe(8e9)
      expect(info?.HostConfig.PidsLimit).toBe(8192)
      expect(info?.HostConfig.NetworkMode).toBe(sandboxNetwork(a.run))

      // /src is the sandbox's own bare repository of the two commits, not the project folder.
      const src = await exec(a, "test -f /src/HEAD && ls /src | grep -c index.html; true")
      expect(src.stdout.trim()).toBe("0")

      const served = await start(b, "web", "python3 -m http.server 8082", { port: 8082 })
      expect(served.wait?.ok).toBe(true)
      const ip = (
        await docker([
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${sandboxNetwork(b.run)}").IPAddress}}`,
          b.container,
        ])
      ).stdout.trim()
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      const reach = await exec(
        a,
        `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://${ip}:8082/`,
      )
      expect(reach.stdout.trim()).not.toBe("200")

      // A symlink the sandbox leaves is refused on the way out, and nothing is copied.
      await exec(
        a,
        "mkdir -p /tmp/out && echo ok > /tmp/out/a.txt && ln -s /etc/passwd /tmp/out/link",
      )
      const local = join(await mkdtemp(join(tmpdir(), "pr2video-out-")), "out")
      const copied = await copyOut(a.container, "/tmp/out", local)
      expect(copied.code).toBe(1)
      expect(copied.stderr).toMatch(/refused/)
      await expect(import("node:fs/promises").then((fs) => fs.stat(local))).rejects.toThrow()
    } finally {
      await down(a)
      await down(b)
    }
    expect((await docker(["network", "inspect", sandboxNetwork(a.run)])).code).not.toBe(0)
  }, 900_000)

  it("waits for a server on ::1 only, and records a start only when its port answers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-start-"))
    await writeFile(
      join(dir, "server.js"),
      "require('http').createServer((q, r) => r.end('ok')).listen(4400, '::1')",
    )
    const box = await up({ cwd: dir, run: `test-start-${Date.now().toString(36)}` })
    try {
      const v6 = await start(box, "v6", "node server.js", { port: 4400, record: true })
      expect(v6.wait?.ok).toBe(true)
      expect(v6.recorded).toBe(true)
      const never = await start(box, "never", "sleep 60", {
        port: 4401,
        record: true,
        timeoutMs: 3_000,
      })
      expect(never.wait?.ok).toBe(false)
      expect(never.recorded).toBe(false)
      expect((await readJournal(box.repo, box.run)).map((e) => e.kind)).toEqual(["start"])
    } finally {
      await down(box)
    }
  }, 600_000)
})
