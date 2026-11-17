/**
 * A first tour from what the head recorded: one tour scene per checkpoint
 * reached, in the scenes file's order, with the checkpoint's caption, focus
 * and marks as recorded. The agent then edits it (order, captions, marks
 * against the base) and `pr2video tour check` validates it.
 *
 * Each tour scene is a window of its recording: from the previous
 * checkpoint shown on that recording (or the start) to the next (or the end),
 * so consecutive scenes play the drive once, without overlap.
 */
import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"

import { type Tour, type TourScene, zoomThatFits } from "@pr2video/tour"

import { decodePng, pixelDifference } from "./png.ts"
import { type SceneResult, sceneResultSchema } from "./result.ts"
import { type Checkpoint, isCheckpoint, type ScenesFile } from "./scenes.ts"

export type DraftOptions = {
  scenes: ScenesFile
  /** Where `record --side head` left its scene folders. */
  recordings: string
  /** The directory `tour.json` will be written in: paths in it are relative to here. */
  tourDir: string
  /**
   * Where `record --side base` left its scenes: each head checkpoint the base
   * also reached is shown first as it was before the change, with a caption
   * left for the agent to write - unless its screenshot looks the same as the
   * head's, when there is nothing before to show.
   */
  base?: string | undefined
  /**
   * With `base`, only these checkpoints get a "before": head tour scene ids
   * (`<scene>-<checkpoint>`), checkpoint names or scene ids. All, when unset.
   */
  befores?: ReadonlySet<string> | undefined
}

type Box = { x: number; y: number; width: number; height: number }

/**
 * The zoom a draft gives a checkpoint the scenes file left to it: 1.5 towards
 * a focus, 2 towards marks with no focus, each only as far as what it zooms
 * towards still fits (a wide section stays at 1 instead of a warning later).
 */
function draftZoom(
  focus: { box: Box } | null,
  marks: ReadonlyArray<{ box: Box }>,
  viewport: { width: number; height: number },
): 1 | 1.5 | 2 {
  if (focus) return zoomThatFits(focus.box, viewport, 1.5)
  if (!marks.length) return 1
  const x = Math.min(...marks.map((m) => m.box.x))
  const y = Math.min(...marks.map((m) => m.box.y))
  const right = Math.max(...marks.map((m) => m.box.x + m.box.width))
  const bottom = Math.max(...marks.map((m) => m.box.y + m.box.height))
  return zoomThatFits({ width: right - x, height: bottom - y }, viewport, 2)
}

/** The path a checkpoint was on, to tell a base that landed elsewhere (a redirect, a 404). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, "")
  } catch {
    return url
  }
}

export type DraftResult = { tour: Tour; skipped: Array<{ scene: string; reason: string }> }

/** The caption a "before" scene starts with: `tour check` refuses it until it is written. */
export const BEFORE_CAPTION = "TODO: say what the base shows here, before the change"

async function readResult(dir: string, scene: string): Promise<SceneResult | null> {
  try {
    return sceneResultSchema.parse(
      JSON.parse(await readFile(join(dir, scene, "result.json"), "utf8")),
    )
  } catch {
    return null
  }
}

/**
 * Below this share of visibly different pixels (about 100 at 1280x800), two
 * screenshots show the same thing: one changed word in a field is ~0.05%.
 */
const SAME_SCREEN = 0.0001

/** Whether two checkpoint screenshots look the same; false when either cannot be read. */
async function looksSame(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)])
    return pixelDifference(decodePng(left), decodePng(right)) < SAME_SCREEN
  } catch {
    return false
  }
}

export async function draftTour(options: DraftOptions): Promise<DraftResult> {
  const scenes: Array<TourScene> = []
  const skipped: DraftResult["skipped"] = []
  let label = 0
  for (const scene of options.scenes.scenes) {
    let result: SceneResult
    try {
      result = sceneResultSchema.parse(
        JSON.parse(await readFile(join(options.recordings, scene.id, "result.json"), "utf8")),
      )
    } catch {
      skipped.push({ scene: scene.id, reason: "not recorded" })
      continue
    }
    if (!result.checkpoints.length) {
      skipped.push({ scene: scene.id, reason: result.error?.message ?? "no checkpoint reached" })
      continue
    }
    label++
    const specs = new Map(
      scene.steps.filter(isCheckpoint).map((step): [string, Checkpoint] => [step.checkpoint, step]),
    )
    const events = relative(options.tourDir, join(options.recordings, scene.id, result.events))
    const before = options.base ? await readResult(options.base, scene.id) : null
    const baseEvents =
      before && options.base
        ? relative(options.tourDir, join(options.base, scene.id, before.events))
        : null
    /** The base screenshot the last "before" showed: two checkpoints on one base screen get one. */
    let lastBefore: string | null = null
    for (const [i, cp] of result.checkpoints.entries()) {
      const spec = specs.get(cp.checkpoint)
      const was = before?.checkpoints.findIndex((b) => b.checkpoint === cp.checkpoint) ?? -1
      const baseCp = before && was >= 0 ? before.checkpoints[was] : undefined
      const same =
        baseCp &&
        options.base &&
        (await looksSame(
          join(options.recordings, scene.id, cp.screenshot),
          join(options.base, scene.id, baseCp.screenshot),
        ))
      const wanted =
        !options.befores ||
        options.befores.has(`${scene.id}-${cp.checkpoint}`) ||
        options.befores.has(cp.checkpoint) ||
        options.befores.has(scene.id)
      const elsewhere = baseCp !== undefined && pathOf(baseCp.url) !== pathOf(cp.url)
      if (same)
        skipped.push({
          scene: `${scene.id}-${cp.checkpoint}-before`,
          reason: "the base looks the same at this checkpoint",
        })
      else if (elsewhere)
        skipped.push({
          scene: `${scene.id}-${cp.checkpoint}-before`,
          reason: `the base ended on ${pathOf(baseCp.url) || "/"}, not ${pathOf(cp.url) || "/"} (a redirect or a page it does not have)`,
        })
      else if (baseCp && !wanted)
        skipped.push({ scene: `${scene.id}-${cp.checkpoint}-before`, reason: "not in --before" })
      const baseShot =
        baseCp && options.base ? join(options.base, scene.id, baseCp.screenshot) : null
      const repeat =
        !same &&
        !elsewhere &&
        wanted &&
        baseShot !== null &&
        lastBefore !== null &&
        (await looksSame(lastBefore, baseShot))
      if (repeat)
        skipped.push({
          scene: `${scene.id}-${cp.checkpoint}-before`,
          reason: "the base shows the same screen as the previous before",
        })
      if (before && baseCp && baseEvents && !same && !elsewhere && wanted && !repeat) {
        lastBefore = baseShot
        const previous = before.checkpoints[was - 1]
        const next = before.checkpoints[was + 1]
        scenes.push({
          id: `${scene.id}-${cp.checkpoint}-before`,
          label: `S${label}.${i + 1} before`,
          events: baseEvents,
          viewport: before.viewport,
          startMs: previous ? previous.shotMs : 0,
          endMs: next
            ? Math.max(baseCp.shotMs, next.atMs - 1)
            : Math.max(baseCp.shotMs, before.durationMs),
          atMs: baseCp.atMs,
          shotMs: baseCp.shotMs,
          caption:
            `${BEFORE_CAPTION} (head: ${spec?.caption ?? scene.title})` +
            (!baseCp.focus && !baseCp.marks.length && (cp.focus || cp.marks.length)
              ? ". The base has none of the head's focus or marks here: keep this before only if their absence is worth showing"
              : ""),
          focus: baseCp.focus,
          zoom: spec?.zoom ?? draftZoom(baseCp.focus, baseCp.marks, before.viewport),
          markers: baseCp.marks.map((mark) => ({
            box: mark.box,
            node: mark.node,
            label: mark.label,
            tone: "note" as const,
          })),
          audio: null,
          audioMs: null,
        })
      }
      const previous = result.checkpoints[i - 1]
      const next = result.checkpoints[i + 1]
      scenes.push({
        id: `${scene.id}-${cp.checkpoint}`,
        label: `S${label}.${i + 1}`,
        events,
        viewport: result.viewport,
        startMs: previous ? previous.shotMs : 0,
        endMs: next ? Math.max(cp.shotMs, next.atMs - 1) : Math.max(cp.shotMs, result.durationMs),
        atMs: cp.atMs,
        shotMs: cp.shotMs,
        caption: spec?.caption ?? scene.title,
        focus: cp.focus,
        zoom: spec?.zoom ?? draftZoom(cp.focus, cp.marks, result.viewport),
        markers: cp.marks.map((mark) => ({
          box: mark.box,
          node: mark.node,
          label: mark.label,
          tone: mark.tone,
        })),
        audio: null,
        audioMs: null,
      })
    }
    if (result.status === "partly")
      skipped.push({
        scene: scene.id,
        reason: `partly: ${result.error?.message ?? "stopped early"}`,
      })
  }
  return {
    tour: {
      version: 1,
      title: options.scenes.title,
      summary: options.scenes.summary,
      scenes,
      voice: "none",
    },
    skipped,
  }
}
