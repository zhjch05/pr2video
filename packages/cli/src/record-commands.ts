/**
 * `pr2video scenes check`, `pr2video record` and `pr2video tour draft`: from
 * the agent's scenes file to recordings of the head and base, to a first tour.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { draftTour, type SceneResult, scenesFileSchema, scenesProblems } from "@pr2video/recorder"
import { docker, exec, resolveRecord, runDir, type SandboxRecord } from "@pr2video/sandbox"
import type { Tour, TourScene } from "@pr2video/tour"

export type RecordFlags = {
  json?: boolean | undefined
  run?: string | undefined
  side?: string | undefined
  scenes?: string | undefined
  only?: string | undefined
  output?: string | undefined
  compare?: boolean | undefined
  fresh?: boolean | undefined
}

export const RECORD_HELP = `Recording:
  pr2video scenes check [<scenes.json>] [--json]  Validate a scenes file (default .pr2video/<run>/scenes.json)
  pr2video record [--side head|base] [--scenes <file>] [--only <id,id>]
                                                Record the scenes in the sandbox's browser
  pr2video tour draft [--compare] [--fresh] [--scenes <file>] [-o <tour.json>]
                                                A first tour from the head's recordings; --compare puts
                                                each checkpoint's base recording before it ("before").
                                                Drafting over an existing tour keeps its scenes, order,
                                                titles, labels, captions and zooms, and takes recordings,
                                                timings, focus and marks fresh; --fresh starts over`

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
    // The recorder's own Chromium, apart from any the project installed.
    `PLAYWRIGHT_BROWSERS_PATH=${INSIDE}/browsers node ${INSIDE}/record.mjs --scenes ${INSIDE}/scenes.json --side ${side} --out ${out}${flags.only ? ` --only ${JSON.stringify(flags.only)}` : ""}`,
  ].join(" && ")
  const result = await exec(record, command, {
    cwd: INSIDE,
    timeoutMs: 30 * 60_000,
    onOutput: flags.json ? undefined : (chunk) => process.stdout.write(chunk),
  })
  const local = join(runDir(record.repo, record.run), "recordings", side)
  const incoming = join(runDir(record.repo, record.run), "recordings", `.incoming-${side}`)
  await rm(incoming, { recursive: true, force: true })
  await mkdir(local, { recursive: true })
  const copied = await docker(["cp", `${record.container}:${out}`, incoming])
  // Only the scenes just recorded are replaced: re-recording one with --only
  // (or from another scenes file) keeps every other scene's recording.
  const recorded: Array<string> = []
  let signIn: { message: string; screenshot: string | null } | null = null
  if (copied.code === 0) {
    const incomingSummary = (await readJson(join(incoming, "summary.json")).catch(() => null)) as {
      signIn?: { message: string; screenshot: string | null }
    } | null
    signIn = incomingSummary?.signIn ?? null
    if (signIn?.screenshot) {
      await rename(join(incoming, signIn.screenshot), join(local, signIn.screenshot)).catch(
        () => undefined,
      )
      signIn = { ...signIn, screenshot: join(local, signIn.screenshot) }
    }
    // A sign-in that worked this time clears the screenshot of one that did not.
    if (!signIn)
      for (const name of await readdir(local))
        if (/^\.auth-.*-stopped\.png$/.test(name)) await rm(join(local, name), { force: true })
    for (const entry of await readdir(incoming, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      await rm(join(local, entry.name), { recursive: true, force: true })
      await rename(join(incoming, entry.name), join(local, entry.name))
      recorded.push(entry.name)
    }
    await rm(incoming, { recursive: true, force: true })
    await writeSummary(local, side)
  }
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
  const scenes = (await sceneResults(local)).filter((r) => recorded.includes(r.scene))
  const ok = result.exitCode === 0 && scenes.length > 0
  if (flags.json)
    console.log(JSON.stringify({ ok, side, recordings: local, scenes, signIn }, null, 2))
  else if (signIn) {
    console.error(`\npr2video: ${signIn.message}`)
    if (signIn.screenshot) console.error(`  where it stopped: ${signIn.screenshot}`)
  } else {
    console.log(`\nrecordings in ${local}`)
    for (const s of scenes)
      console.log(`  ${s.scene}: ${s.status}${s.error ? ` (stopped: ${s.error.message})` : ""}`)
  }
  return ok ? 0 : 1
}

/** Every scene recorded on a side, from each scene folder's result.json. */
async function sceneResults(
  local: string,
): Promise<Array<Pick<SceneResult, "scene" | "status" | "error">>> {
  const out: Array<Pick<SceneResult, "scene" | "status" | "error">> = []
  for (const entry of await readdir(local, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const result = (await readJson(join(local, entry.name, "result.json")).catch(
      () => null,
    )) as SceneResult | null
    if (result) out.push({ scene: result.scene, status: result.status, error: result.error })
  }
  return out
}

/** `summary.json` lists every scene the side holds, not only the last recording's. */
async function writeSummary(local: string, side: string): Promise<void> {
  await writeFile(
    join(local, "summary.json"),
    `${JSON.stringify({ side, scenes: await sceneResults(local) }, null, 2)}\n`,
  )
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
    base: flags.compare ? join(dir, "recordings", "base") : undefined,
  })
  if (!tour.scenes.length)
    throw new Error("nothing was recorded on the head: run `pr2video record` first")
  const previous = flags.fresh ? null : await readJson(out).catch(() => null)
  const merged = previous
    ? keepWritten(tour, previous)
    : { tour, kept: [], notInTour: [], gone: [] }
  await writeFile(out, `${JSON.stringify(merged.tour, null, 2)}\n`)
  if (flags.json)
    console.log(
      JSON.stringify(
        {
          ok: true,
          tour: out,
          scenes: merged.tour.scenes.length,
          skipped,
          kept: merged.kept,
          notInTour: merged.notInTour,
          gone: merged.gone,
        },
        null,
        2,
      ),
    )
  else {
    console.log(`${out} (${merged.tour.scenes.length} scenes)`)
    for (const s of skipped) console.log(`  left out ${s.scene}: ${s.reason}`)
    if (previous) {
      console.log(
        `  kept the captions, order and zoom of ${merged.kept.length} scene(s) from the tour that was there`,
      )
      if (merged.notInTour.length)
        console.log(
          `  drafted but not in your tour (deleted, or new): ${merged.notInTour.join(", ")}; --fresh starts over`,
        )
      for (const id of merged.gone) console.log(`  removed ${id}: no longer recorded`)
    }
  }
  return 0
}

/**
 * A new draft laid over a tour already written: the written tour's scenes,
 * in its order, keep what a person wrote (label, caption, zoom; the title and
 * summary) and take what the recordings decide (recording, viewport, timings,
 * focus and marks: those name nodes of that recording) from the draft.
 */
export function keepWritten(
  draft: Tour,
  previous: unknown,
): { tour: Tour; kept: Array<string>; notInTour: Array<string>; gone: Array<string> } {
  const old = previous as Partial<Tour> | null
  if (!old || !Array.isArray(old.scenes)) return { tour: draft, kept: [], notInTour: [], gone: [] }
  const drafted = new Map(draft.scenes.map((s) => [s.id, s]))
  const scenes: Array<TourScene> = []
  const kept: Array<string> = []
  const gone: Array<string> = []
  for (const written of old.scenes) {
    const fresh = drafted.get(written.id)
    if (!fresh) {
      gone.push(written.id)
      continue
    }
    scenes.push({
      ...fresh,
      label: written.label ?? fresh.label,
      caption: written.caption ?? fresh.caption,
      zoom: written.zoom ?? fresh.zoom,
    })
    kept.push(written.id)
  }
  const ids = new Set(kept)
  const notInTour = draft.scenes.filter((s) => !ids.has(s.id)).map((s) => s.id)
  if (!scenes.length) return { tour: draft, kept: [], notInTour: [], gone }
  return {
    tour: {
      ...draft,
      title: old.title || draft.title,
      summary: old.summary ?? draft.summary,
      scenes,
    },
    kept,
    notInTour,
    gone,
  }
}
