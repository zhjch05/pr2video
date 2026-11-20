import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { commitsRepo, folderFiles } from "../src/source.ts"

const EXCLUDES = [".git", ".pr2video", "node_modules"]

async function gitRepo(): Promise<{ dir: string; git: (...args: Array<string>) => string }> {
  const dir = await mkdtemp(join(tmpdir(), "pr2video-source-"))
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "test")
  return { dir, git }
}

describe("folderFiles", () => {
  it("in git: tracked and untracked files, not ignored, deleted or excluded ones", async () => {
    const { dir, git } = await gitRepo()
    await writeFile(join(dir, ".gitignore"), ".env\n")
    await writeFile(join(dir, "index.html"), "x")
    await writeFile(join(dir, "gone.txt"), "x")
    git("add", ".")
    git("commit", "-q", "-m", "one")
    await rm(join(dir, "gone.txt"))
    await writeFile(join(dir, ".env"), "SECRET=1")
    await writeFile(join(dir, "new.txt"), "x")
    await mkdir(join(dir, "node_modules/a"), { recursive: true })
    await writeFile(join(dir, "node_modules/a/index.js"), "x")
    expect((await folderFiles(dir, true, EXCLUDES)).sort()).toEqual([
      ".gitignore",
      "index.html",
      "new.txt",
    ])
  })

  it("outside git: every file but the excluded folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-plain-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src/app.js"), "x")
    await mkdir(join(dir, "node_modules/a"), { recursive: true })
    await writeFile(join(dir, "node_modules/a/index.js"), "x")
    expect(await folderFiles(dir, false, EXCLUDES)).toEqual(["src/app.js"])
  })
})

describe("commitsRepo", () => {
  it("holds just the commits asked for, without history", async () => {
    const { dir, git } = await gitRepo()
    await writeFile(join(dir, "a.txt"), "1")
    git("add", ".")
    git("commit", "-q", "-m", "one")
    await writeFile(join(dir, "a.txt"), "2")
    git("commit", "-q", "-am", "two")
    const head = git("rev-parse", "HEAD")
    const bare = await commitsRepo(dir, [head])
    try {
      const count = execFileSync("git", ["-C", bare, "rev-list", "--count", "--all"], {
        encoding: "utf8",
      }).trim()
      expect(count).toBe("1")
      const content = execFileSync("git", ["-C", bare, "show", `${head}:a.txt`], {
        encoding: "utf8",
      })
      expect(content).toBe("2")
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})
