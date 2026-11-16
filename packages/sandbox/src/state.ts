/**
 * What a run keeps on the host, in `<repo>/.pr2video/<run>/`: the sandbox's
 * record (`sandbox.json`), the journal of setup steps (`journal.jsonl`) and
 * every command's full output (`logs/`). `.pr2video/current` names the run
 * commands use when none is given.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import * as z from "zod"

export const sandboxRecordSchema = z.object({
  run: z.string(),
  container: z.string(),
  image: z.string(),
  repo: z.string(),
  head: z.object({ ref: z.string(), sha: z.string(), dir: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string(), dir: z.string() }).nullable(),
  createdAt: z.string(),
})
export type SandboxRecord = z.infer<typeof sandboxRecordSchema>

/**
 * One recorded setup step. `exec` ran to completion; `start` left a process
 * running (a server, a watcher), optionally waited for until `port` answered;
 * `copy` put a host file in the sandbox, from a copy the run keeps so replay
 * does not depend on the host file still being there.
 */
export const journalEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exec"),
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().nullable(),
    ms: z.number(),
    at: z.string(),
  }),
  z.object({
    kind: z.literal("start"),
    name: z.string(),
    command: z.string(),
    cwd: z.string(),
    port: z.number().nullable(),
    path: z.string().nullable().optional(),
    at: z.string(),
  }),
  z.object({
    kind: z.literal("copy"),
    /** The copy kept under the run's `files/`, relative to the run directory. */
    from: z.string(),
    to: z.string(),
    at: z.string(),
  }),
])
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const STATE_DIR = ".pr2video"

export function runDir(repo: string, run: string): string {
  return join(repo, STATE_DIR, run)
}

export async function writeRecord(record: SandboxRecord): Promise<void> {
  const dir = runDir(record.repo, record.run)
  await mkdir(join(dir, "logs"), { recursive: true })
  await writeFile(join(dir, "sandbox.json"), `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(record.repo, STATE_DIR, "current"), `${record.run}\n`)
  // The state directory never belongs in the repository's history.
  await writeFile(join(record.repo, STATE_DIR, ".gitignore"), "*\n")
}

export async function currentRun(repo: string): Promise<string | null> {
  try {
    return (await readFile(join(repo, STATE_DIR, "current"), "utf8")).trim() || null
  } catch {
    return null
  }
}

export async function readRecord(repo: string, run: string): Promise<SandboxRecord> {
  let text: string
  try {
    text = await readFile(join(runDir(repo, run), "sandbox.json"), "utf8")
  } catch {
    throw new Error(`no sandbox for run "${run}"; start one with \`pr2video sandbox up\``)
  }
  return sandboxRecordSchema.parse(JSON.parse(text))
}

export async function appendJournal(repo: string, run: string, entry: JournalEntry): Promise<void> {
  await appendFile(join(runDir(repo, run), "journal.jsonl"), `${JSON.stringify(entry)}\n`)
}

/** Removes step `n` (1-based) from the journal; returns the step removed. */
export async function dropJournalStep(repo: string, run: string, n: number): Promise<JournalEntry> {
  const journal = await readJournal(repo, run)
  const [dropped] = Number.isInteger(n) && n >= 1 ? journal.splice(n - 1, 1) : []
  if (!dropped) throw new Error(`no step ${n}: the journal has ${journal.length} step(s)`)
  await writeFile(
    join(runDir(repo, run), "journal.jsonl"),
    journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  )
  return dropped
}

export async function readJournal(repo: string, run: string): Promise<Array<JournalEntry>> {
  let text = ""
  try {
    text = await readFile(join(runDir(repo, run), "journal.jsonl"), "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => journalEntrySchema.parse(JSON.parse(line)))
}

/**
 * A recorded step moved from the head checkout to another: a cwd under the
 * head's directory is re-rooted, and so is each mention of it in the command.
 */
export function rebase(entry: JournalEntry, fromDir: string, toDir: string): JournalEntry {
  const move = (text: string) => text.split(fromDir).join(toDir)
  if (entry.kind === "copy") return { ...entry, to: move(entry.to) }
  return { ...entry, cwd: move(entry.cwd), command: move(entry.command) }
}

/** Keeps the last `max` bytes of `text`, saying how much was cut. */
export function tail(text: string, max = 16_000): string {
  if (Buffer.byteLength(text) <= max) return text
  const kept = Buffer.from(text).subarray(-max).toString("utf8")
  return `… (${Buffer.byteLength(text) - max} earlier bytes in the log)\n${kept}`
}
