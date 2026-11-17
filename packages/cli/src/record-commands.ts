/**
 * `pr2video scenes check`, `pr2video record` and `pr2video tour draft`: from
 * the agent's scenes file to recordings of the head and base, to a first tour.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  draftTour,
  type SceneResult,
  type ScenesFile,
  scenesFileSchema,
  scenesProblems,
} from "@pr2video/recorder"
import { docker, exec, resolveRecord, runDir, type SandboxRecord } from "@pr2video/sandbox"
import type { Tour, TourScene } from "@pr2video/tour"

import { assetPath } from "./assets.ts"

export type RecordFlags = {
  json?: boolean | undefined
  run?: string | undefined
  side?: string | undefined
  scenes?: string | undefined
  only?: string | undefined
  output?: string | undefined
  compare?: boolean | undefined
  before?: string | undefined
  fresh?: boolean | undefined
  role?: string | undefined
  find?: Array<string> | undefined
}

/** `pr2video scenes --help`: what a scene's steps can be. */
export const SCENES_HELP = `Scene steps (scenes.json; at most 10 actions per scene, checkpoints not counted):
  { "goto": "/path" }                           Open a page (relative to baseUrl)
  { "click": <locator> }                         Click
  { "hover": <locator> }                         Hover
  { "fill": <locator>, "value": "text" }         Type into a field (shown as typed)
  { "select": <locator>, "value": "option" }     Pick an option
  { "check": <locator> } / { "uncheck": <locator> }
  { "press": "Enter", "on": <locator>, "times": 8 }
                                                Press a key (on an element, or the page); times repeats it
  { "waitFor": <locator> }                       Wait until it shows
  { "wait": 600 }                                Wait n ms (up to 10000)
  { "scrollTo": <locator> }                      Scroll it to the middle (a checkpoint's focus does this itself)
  { "checkpoint": "id", "caption": "...", "focus": <locator>, "zoom": 1.5,
    "marks": [{ "locator": <locator>, "tone": "added|removed|changed|note", "label": null }] }
                                                Stop here: screenshot, focus, marks, caption

Locators, exactly one of:
  { "role": "button", "name": "Save" }  { "label": "Email" }  { "text": "Total" }
  { "placeholder": "Search" }  { "testId": "cart" }  { "css": "div:has(> h2)" }
  plus "exact": true (the whole name or text, not a part) and "nth": 0 (one of several)`

export const RECORD_HELP = `Recording:
  pr2video scenes check [<scenes.json>] [--json]  Validate a scenes file (default .pr2video/<run>/scenes.json)
  pr2video record [--side head|base] [--scenes <file>] [--only <id,id>]
                                                Record the scenes in the sandbox's browser
  pr2video tour draft [--compare | --before <id,id>] [--fresh] [--scenes <file>] [-o <tour.json>]
                                                A first tour from the head's recordings; --compare puts
                                                each checkpoint's base recording before it ("before")
                                                where its screenshot differs from the head's; --before
                                                does that only for the checkpoints named (scene ids,
                                                checkpoint names, or <scene>-<checkpoint>).
                                                Drafting over an existing tour keeps its scenes, order,
                                                titles, labels, captions and zooms, and takes recordings,
                                                timings, focus and marks fresh; --fresh starts over
  pr2video probe <url> [--role <role>] [--find '<locator json>']...
                                                Open one page in the sandbox's browser (signed in as a
                                                role from scenes.json) without recording: with --find,
                                                what each locator matches (count, box, text); without,
                                                the page's headings, controls and fields with their
                                                roles and names. Writes probe.png beside it`

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

/**
 * `pr2video probe`: what a locator matches on the live page, before a scene
 * depends on it. curl sees a single-page app's empty shell; this sees what the
 * recorder will see, signed in the same way.
 */
export async function probeCommand(
  args: ReadonlyArray<string>,
  flags: RecordFlags,
): Promise<number> {
  const [url] = args
  if (!url)
    throw new Error("usage: pr2video probe <url> [--role <role>] [--find '<locator json>']...")
  const record = await resolveRecord(process.cwd(), flags.run)
  const dir = runDir(record.repo, record.run)
  const path = await scenesPath(record, flags.scenes)
  let scenesFile: string
  const existing = await readFile(path, "utf8").catch(() => null)
  if (existing !== null) {
    const problems = problemsOf(JSON.parse(existing))
    if (problems.length)
      throw new Error(
        `the scenes file has problems; fix them first (the probe reads its baseUrl, viewport and roles):\n${problems.map((p) => `${p.path}: ${p.message}`).join("\n")}`,
      )
    scenesFile = path
  } else {
    // No scenes yet: a full URL is enough, with no roles.
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      throw new Error(`no ${path} yet: give a full URL (http://localhost:<port>/...)`)
    }
    if (flags.role) throw new Error(`--role ${flags.role}: no ${path} yet to define it in`)
    scenesFile = join(dir, ".probe-scenes.json")
    await mkdir(dir, { recursive: true })
    await writeFile(
      scenesFile,
      JSON.stringify(
        scenesFileSchema.parse({
          version: 1,
          title: "probe",
          baseUrl: origin,
          scenes: [
            {
              id: "probe",
              title: "probe",
              url: "/",
              steps: [{ checkpoint: "probe", caption: "probe" }],
            },
          ],
        }),
      ),
    )
  }
  const recorder = await assetPath("record.mjs")
  for (const [from, to] of [
    [recorder, `${record.container}:${INSIDE}/record.mjs`],
    [scenesFile, `${record.container}:${INSIDE}/probe-scenes.json`],
  ] as const) {
    const copied = await docker(["cp", from, to])
    if (copied.code !== 0) throw new Error(`docker cp failed: ${copied.stderr.trim()}`)
  }
  const out = `${INSIDE_OUT}/probe`
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const command = [
    `rm -rf ${out}`,
    `PLAYWRIGHT_BROWSERS_PATH=${INSIDE}/browsers node ${INSIDE}/record.mjs --scenes ${INSIDE}/probe-scenes.json --out ${out} --probe ${quote(url)}` +
      (flags.role ? ` --role ${quote(flags.role)}` : "") +
      (flags.find ?? []).map((find) => ` --find ${quote(find)}`).join(""),
  ].join(" && ")
  const result = await exec(record, command, { cwd: INSIDE, timeoutMs: 5 * 60_000 })
  const local = join(dir, "probe")
  await rm(local, { recursive: true, force: true })
  const copied = await docker(["cp", `${record.container}:${out}`, local])
  if (result.exitCode !== 0 || copied.code !== 0) {
    const reason = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n")
    if (flags.json) console.log(JSON.stringify({ ok: false, error: reason }, null, 2))
    else console.error(`pr2video: the probe failed:\n${reason}`)
    return 1
  }
  const report = (await readJson(join(local, "probe.json"))) as {
    url: string
    status: number | null
    title: string
    finds: Array<{
      locator: string
      count?: number
      error?: string
      matches?: Array<{
        visible: boolean
        box: { x: number; y: number; width: number; height: number } | null
        tag: string
        text: string
      }>
    }>
    outline: Array<{ role: string; name: string; testId: string | null }>
  }
  if (flags.json) {
    console.log(
      JSON.stringify({ ok: true, ...report, screenshot: join(local, "probe.png") }, null, 2),
    )
    return 0
  }
  console.log(`${report.url} (${report.status ?? "no status"}) "${report.title}"`)
  for (const find of report.finds) {
    if (find.error) {
      console.log(`  ${find.locator}: ${find.error}`)
      continue
    }
    console.log(`  ${find.locator}: ${find.count} match${find.count === 1 ? "" : "es"}`)
    for (const m of find.matches ?? [])
      console.log(
        `    <${m.tag}> ${m.visible ? "" : "(hidden) "}${m.box ? `at ${m.box.x},${m.box.y} ${m.box.width}x${m.box.height}` : "no box"}${m.text ? ` "${m.text}"` : ""}`,
      )
  }
  if (report.outline.length) {
    console.log('  on the page (role "name"; check a locator with --find before relying on it):')
    for (const item of report.outline)
      console.log(
        `    ${item.role} ${JSON.stringify(item.name)}${item.testId ? ` testId=${JSON.stringify(item.testId)}` : ""}`,
      )
  }
  console.log(`screenshot: ${join(local, "probe.png")}`)
  return 0
}

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
  // A server that is not up (a replay that failed, a dev server that died)
  // would fail every scene one timeout at a time: say so at once.
  const baseUrl = (input as { baseUrl?: string }).baseUrl
  if (baseUrl) {
    const probe = await exec(
      record,
      `curl -s -o /dev/null -m 10 -w '%{http_code}' ${JSON.stringify(baseUrl)} || true`,
      { cwd: INSIDE },
    )
    const code = probe.stdout.trim()
    if (!code || code === "000")
      throw new Error(
        `nothing answers at ${baseUrl} in the sandbox: start the app first (\`pr2video sandbox ps\` shows what is running; after a replay, check that it succeeded)`,
      )
  }
  const recorder = await assetPath("record.mjs")
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
      console.log(
        `  ${s.scene}: ${s.status}${s.error ? ` (stopped: ${s.error.message})` : ""}` +
          (side === "head" && s.missing.length
            ? `; not found, so not marked: ${s.missing.join("; ")}`
            : ""),
      )
  }
  return ok ? 0 : 1
}

type SceneSummary = Pick<SceneResult, "scene" | "status" | "error"> & {
  /** `<checkpoint> <locator>` for each focus or mark that was not on the page. */
  missing: Array<string>
}

/** Every scene recorded on a side, from each scene folder's result.json. */
async function sceneResults(local: string): Promise<Array<SceneSummary>> {
  const out: Array<SceneSummary> = []
  for (const entry of await readdir(local, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const result = (await readJson(join(local, entry.name, "result.json")).catch(
      () => null,
    )) as SceneResult | null
    if (result)
      out.push({
        scene: result.scene,
        status: result.status,
        error: result.error,
        missing: result.checkpoints.flatMap((cp) =>
          (cp.missing ?? []).map((gone) => `${cp.checkpoint} ${gone}`),
        ),
      })
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

/**
 * `--before` ids: a scene, a checkpoint, or `<scene>-<checkpoint>` (`/` is read
 * as `-`). An id that names nothing is an error, not a silent "left out".
 */
function beforeIds(scenes: ScenesFile, list: string): Set<string> {
  const known = new Set<string>()
  const pairs: string[] = []
  for (const scene of scenes.scenes) {
    known.add(scene.id)
    for (const step of scene.steps)
      if ("checkpoint" in step) {
        known.add(step.checkpoint)
        pairs.push(`${scene.id}-${step.checkpoint}`)
      }
  }
  for (const pair of pairs) known.add(pair)
  const ids = list
    .split(",")
    .map((id) => id.trim().replace("/", "-"))
    .filter(Boolean)
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length)
    throw new Error(
      `--before ${unknown.join(", ")}: no such scene or checkpoint. Use a scene id, a checkpoint id, or <scene>-<checkpoint>, e.g. ${pairs.slice(0, 2).join(", ")}`,
    )
  return new Set(ids)
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
    base: flags.compare || flags.before ? join(dir, "recordings", "base") : undefined,
    befores: flags.before ? beforeIds(scenes, flags.before) : undefined,
  })
  if (!tour.scenes.length)
    throw new Error("nothing was recorded on the head: run `pr2video record` first")
  const previous = flags.fresh ? null : await readJson(out).catch(() => null)
  const merged = previous
    ? keepWritten(tour, previous, { addBefores: Boolean(flags.before) })
    : { tour, kept: [], notInTour: [], gone: [], added: [] }
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
          added: merged.added,
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
          `  drafted but not in your tour (deleted, or new): ${merged.notInTour.join(", ")}; name a before in --before to add it, or --fresh starts over`,
        )
      for (const id of merged.added) console.log(`  added ${id} (asked for with --before)`)
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
  /**
   * Befores asked for by name (`--before`): one the tour does not have yet goes
   * in just ahead of its head scene. Without it a missing before is taken to be
   * one you deleted, and stays out.
   */
  options: { addBefores?: boolean } = {},
): {
  tour: Tour
  kept: Array<string>
  notInTour: Array<string>
  gone: Array<string>
  added: Array<string>
} {
  const old = previous as Partial<Tour> | null
  if (!old || !Array.isArray(old.scenes))
    return { tour: draft, kept: [], notInTour: [], gone: [], added: [] }
  const drafted = new Map(draft.scenes.map((s) => [s.id, s]))
  const scenes: Array<TourScene> = []
  const kept: Array<string> = []
  const gone: Array<string> = []
  const added: Array<string> = []
  const had = new Set(old.scenes.map((s) => s.id))
  for (const written of old.scenes) {
    const fresh = drafted.get(written.id)
    if (!fresh) {
      gone.push(written.id)
      continue
    }
    const before = drafted.get(`${written.id}-before`)
    if (options.addBefores && before && !had.has(before.id)) {
      scenes.push(before)
      added.push(before.id)
    }
    scenes.push({
      ...fresh,
      label: written.label ?? fresh.label,
      caption: written.caption ?? fresh.caption,
      zoom: written.zoom ?? fresh.zoom,
      // Narration belongs to the caption, which is kept: so is its clip.
      ...(written.audio ? { audio: written.audio, audioMs: written.audioMs ?? null } : {}),
    })
    kept.push(written.id)
  }
  const ids = new Set([...kept, ...added])
  const notInTour = draft.scenes.filter((s) => !ids.has(s.id)).map((s) => s.id)
  if (!kept.length) return { tour: draft, kept: [], notInTour: [], gone, added: [] }
  return {
    tour: {
      ...draft,
      title: old.title || draft.title,
      summary: old.summary ?? draft.summary,
      ...(old.voice ? { voice: old.voice } : {}),
      ...(old.speaker ? { speaker: old.speaker } : {}),
      scenes,
    },
    kept,
    notInTour,
    gone,
    added,
  }
}
