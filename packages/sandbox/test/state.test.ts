import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { validRun } from "../src/sandbox.ts"
import {
  appendJournal,
  type JournalEntry,
  readJournal,
  rebase,
  runDir,
  tail,
} from "../src/state.ts"

describe("rebase", () => {
  it("moves a step from the head checkout to the base", () => {
    const entry: JournalEntry = {
      kind: "exec",
      command: "cp /work/head/.env.example /work/head/.env && pnpm install",
      cwd: "/work/head/apps/web",
      exitCode: 0,
      ms: 10,
      at: "2026-11-16T00:00:00Z",
    }
    expect(rebase(entry, "/work/head", "/work/base")).toMatchObject({
      cwd: "/work/base/apps/web",
      command: "cp /work/base/.env.example /work/base/.env && pnpm install",
    })
  })
})

describe("journal", () => {
  it("round-trips steps in order", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr2video-journal-"))
    await mkdir(runDir(repo, "r1"), { recursive: true })
    expect(await readJournal(repo, "r1")).toEqual([])
    await appendJournal(repo, "r1", {
      kind: "exec",
      command: "pnpm i",
      cwd: "/work/head",
      exitCode: 0,
      ms: 5,
      at: "t",
    })
    await appendJournal(repo, "r1", {
      kind: "start",
      name: "web",
      command: "pnpm dev",
      cwd: "/work/head",
      port: 3000,
      at: "t",
    })
    expect((await readJournal(repo, "r1")).map((e) => e.kind)).toEqual(["exec", "start"])
  })
})

describe("tail", () => {
  it("keeps the end and says what it cut", () => {
    const out = tail(`${"a".repeat(100)}END`, 10)
    expect(out.endsWith("END")).toBe(true)
    expect(out).toContain("93 earlier bytes")
    expect(tail("short", 10)).toBe("short")
  })
})

describe("validRun", () => {
  it("accepts ids and refuses anything a container name cannot hold", () => {
    expect(validRun("a1b2c3d4e5")).toBe("a1b2c3d4e5")
    expect(() => validRun("../x")).toThrow()
    expect(() => validRun("a b")).toThrow()
  })
})
