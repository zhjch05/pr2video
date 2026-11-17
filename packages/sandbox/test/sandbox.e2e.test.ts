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
})
