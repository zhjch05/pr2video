/**
 * A real sandbox against this machine's Docker: opt in with
 * PR2VIDEO_TEST_DOCKER=1. Builds the image the first time (minutes).
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import {
  down,
  exec,
  processes,
  readJournal,
  replay,
  type SandboxRecord,
  start,
  up,
} from "../src/index.ts"

const enabled = process.env.PR2VIDEO_TEST_DOCKER === "1"

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
})
