import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { validRun } from "../src/sandbox.ts"
import {
  appendJournal,
  dropJournalStep,
  dropJournalSteps,
  type JournalEntry,
  moveJournalStep,
  readDataManifest,
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

  it("drops one step by its number, and refuses a number it does not have", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr2video-journal-"))
    await mkdir(runDir(repo, "r1"), { recursive: true })
    for (const command of ["a", "b", "c"])
      await appendJournal(repo, "r1", {
        kind: "exec",
        command,
        cwd: "/",
        exitCode: 0,
        ms: 1,
        at: "t",
      })
    expect(await dropJournalStep(repo, "r1", 2)).toMatchObject({ command: "b" })
    expect((await readJournal(repo, "r1")).map((e) => e.kind === "exec" && e.command)).toEqual([
      "a",
      "c",
    ])
    await expect(dropJournalStep(repo, "r1", 0)).rejects.toThrow("no step 0")
    await expect(dropJournalStep(repo, "r1", 3)).rejects.toThrow("the journal has 2 step(s)")
  })

  it("drops a range of steps, keeping the ones after it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr2video-journal-"))
    await mkdir(runDir(repo, "r1"), { recursive: true })
    for (const command of ["a", "b", "c", "d", "e"])
      await appendJournal(repo, "r1", {
        kind: "exec",
        command,
        cwd: "/",
        exitCode: 0,
        ms: 1,
        at: "t",
      })
    const dropped = await dropJournalSteps(repo, "r1", 2, 4)
    expect(dropped.map((e) => e.kind === "exec" && e.command)).toEqual(["b", "c", "d"])
    expect((await readJournal(repo, "r1")).map((e) => e.kind === "exec" && e.command)).toEqual([
      "a",
      "e",
    ])
    await expect(dropJournalSteps(repo, "r1", 2, 5)).rejects.toThrow("no steps 2-5")
  })

  it("moves a step to another position", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr2video-journal-"))
    await mkdir(runDir(repo, "r1"), { recursive: true })
    for (const command of ["a", "b", "c", "d"])
      await appendJournal(repo, "r1", {
        kind: "exec",
        command,
        cwd: "/",
        exitCode: 0,
        ms: 1,
        at: "t",
      })
    expect(await moveJournalStep(repo, "r1", 4, 2)).toMatchObject({ command: "d" })
    expect((await readJournal(repo, "r1")).map((e) => e.kind === "exec" && e.command)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ])
    await expect(moveJournalStep(repo, "r1", 5, 1)).rejects.toThrow("steps are 1 to 4")
  })

  it("moves a copy's destination to the base, not its kept file", () => {
    const entry: JournalEntry = {
      kind: "copy",
      from: "files/1-seed.sh",
      to: "/work/head/seed.sh",
      at: "t",
    }
    expect(rebase(entry, "/work/head", "/work/base")).toMatchObject({
      from: "files/1-seed.sh",
      to: "/work/base/seed.sh",
    })
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

describe("data", () => {
  it("journals a data step, and reads a saved manifest or none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pr2video-data-"))
    await mkdir(runDir(repo, "r1"), { recursive: true })
    await appendJournal(repo, "r1", {
      kind: "exec",
      command: "seed",
      cwd: "/",
      exitCode: 0,
      ms: 1,
      at: "t",
      data: true,
    })
    expect(await readJournal(repo, "r1")).toMatchObject([{ kind: "exec", data: true }])
    expect(await readDataManifest(repo, "r1")).toBeNull()
    const manifest = { steps: 1, volumes: ["pgdata"], paths: ["/opt/go"], bytes: 10, savedAt: "t" }
    await writeFile(join(runDir(repo, "r1"), "data.json"), JSON.stringify(manifest))
    expect(await readDataManifest(repo, "r1")).toEqual(manifest)
  })
})
