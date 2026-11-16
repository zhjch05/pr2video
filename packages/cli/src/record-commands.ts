/**
 * `pr2video scenes check`, `pr2video record` and `pr2video tour draft`: from
 * the agent's scenes file to recordings of the head and base, to a first tour.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { draftTour, type SceneResult, scenesFileSchema, scenesProblems } from "@pr2video/recorder"
import { docker, exec, resolveRecord, runDir, type SandboxRecord } from "@pr2video/sandbox"

export type RecordFlags = {
  json?: boolean | undefined
  run?: string | undefined
  side?: string | undefined
  scenes?: string | undefined
  only?: string | undefined
  output?: string | undefined
}

export const RECORD_HELP = `Recording:
  pr2video scenes check [<scenes.json>] [--json]  Validate a scenes file (default .pr2video/<run>/scenes.json)
  pr2video record [--side head|base] [--scenes <file>] [--only <scene>]
                                                Record the scenes in the sandbox's browser
  pr2video tour draft [--scenes <file>] [-o <tour.json>]
                                                A first tour from the head's recordings`

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`)
  }
}

async function scenesPath(
  record: SandboxRecord | null,
  given: string | undefined,
): Promise<string> {
  if (given) return resolve(given)
  if (!record) throw new Error("give the scenes file, or start a sandbox first")
  return join(runDir(record.repo, record.run), "scenes.json")
}

function problemsOf(input: unknown) {
  return scenesProblems(input)
}

export async function scenesCheck(
  args: ReadonlyArray<string>,
  flags: RecordFlags,
): Promise<number> {
  const record = args[0] ? null : await resolveRecord(process.cwd(), flags.run)
  const path = await scenesPath(record, args[0] ?? flags.scenes)
  const problems = problemsOf(await readJson(path))
  if (flags.json)
    console.log(JSON.stringify({ ok: problems.length === 0, path, problems }, null, 2))
  else if (!problems.length) console.log("scenes ok")
  else for (const p of problems) console.log(`${p.path}: ${p.message}`)
  return problems.length ? 1 : 0
}

const INSIDE = "/opt/pr2video"
const INSIDE_OUT = "/tmp/pr2video-out"

export async function recordCommand(flags: RecordFlags): Promise<number> {
  const side = flags.side ?? "head"
  if (side !== "head" && side !== "base") throw new Error("--side is head or base")
  const record = await resolveRecord(process.cwd(), flags.run)
  const path = await scenesPath(record, flags.scenes)
  const input = await readJson(path)
  const problems = problemsOf(input)
  if (problems.length) {
    const message = problems.map((p) => `${p.path}: ${p.message}`).join("\n")
    throw new Error(`the scenes file has problems; fix them first:\n${message}`)
  }
  const recorder = fileURLToPath(import.meta.resolve("@pr2video/recorder/record.mjs"))
  try {
    await readFile(recorder)
  } catch {
    throw new Error(`the recorder bundle is missing (${recorder}); run \`pnpm build\` first`)
  }
  const copy = async (from: string, to: string) => {
    const result = await docker(["cp", from, to])
    if (result.code !== 0) throw new Error(`docker cp failed: ${result.stderr.trim()}`)
  }
  await copy(recorder, `${record.container}:${INSIDE}/record.mjs`)
  await copy(path, `${record.container}:${INSIDE}/scenes.json`)
  const out = `${INSIDE_OUT}/${side}`
  const command = [
    `rm -rf ${out}`,
    `node ${INSIDE}/record.mjs --scenes ${INSIDE}/scenes.json --side ${side} --out ${out}${flags.only ? ` --only ${JSON.stringify(flags.only)}` : ""}`,
  ].join(" && ")
  const result = await exec(record, command, {
    cwd: INSIDE,
    timeoutMs: 30 * 60_000,
    onOutput: flags.json ? undefined : (chunk) => process.stdout.write(chunk),
  })
  const local = join(runDir(record.repo, record.run), "recordings", side)
  await rm(local, { recursive: true, force: true })
  await mkdir(dirname(local), { recursive: true })
  const copied = await docker(["cp", `${record.container}:${out}`, local])
  if (result.exitCode !== 0 && copied.code !== 0) {
    if (flags.json)
      console.log(
        JSON.stringify(
          { ok: false, exitCode: result.exitCode, stderr: result.stderr, log: result.log },
          null,
          2,
        ),
      )
    else console.error(`pr2video: the recorder failed (exit ${result.exitCode}); see ${result.log}`)
    return 1
  }
  const summary = (await readJson(join(local, "summary.json")).catch(() => null)) as {
    scenes: Array<Pick<SceneResult, "scene" | "status" | "error">>
  } | null
  const scenes = summary?.scenes ?? []
  const ok = result.exitCode === 0 && scenes.length > 0
  if (flags.json) console.log(JSON.stringify({ ok, side, recordings: local, scenes }, null, 2))
  else {
    console.log(`\nrecordings in ${local}`)
    for (const s of scenes)
      console.log(`  ${s.scene}: ${s.status}${s.error ? ` (stopped: ${s.error.message})` : ""}`)
  }
  return ok ? 0 : 1
}

export async function tourDraft(flags: RecordFlags): Promise<number> {
  const record = await resolveRecord(process.cwd(), flags.run)
  const scenes = scenesFileSchema.parse(await readJson(await scenesPath(record, flags.scenes)))
  const dir = runDir(record.repo, record.run)
  const out = resolve(flags.output ?? join(dir, "tour.json"))
  const { tour, skipped } = await draftTour({
    scenes,
    recordings: join(dir, "recordings", "head"),
    tourDir: dirname(out),
  })
  if (!tour.scenes.length)
    throw new Error("nothing was recorded on the head: run `pr2video record` first")
  await writeFile(out, `${JSON.stringify(tour, null, 2)}\n`)
  if (flags.json)
    console.log(
      JSON.stringify({ ok: true, tour: out, scenes: tour.scenes.length, skipped }, null, 2),
    )
  else {
    console.log(`${out} (${tour.scenes.length} scenes)`)
    for (const s of skipped) console.log(`  left out ${s.scene}: ${s.reason}`)
  }
  return 0
}
