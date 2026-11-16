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

import type { Tour, TourScene } from "@pr2video/tour"

import { type SceneResult, sceneResultSchema } from "./result.ts"
import { type Checkpoint, isCheckpoint, type ScenesFile } from "./scenes.ts"

export type DraftOptions = {
  scenes: ScenesFile
  /** Where `record --side head` left its scene folders. */
  recordings: string
  /** The directory `tour.json` will be written in: paths in it are relative to here. */
  tourDir: string
}

export type DraftResult = { tour: Tour; skipped: Array<{ scene: string; reason: string }> }

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
    for (const [i, cp] of result.checkpoints.entries()) {
      const spec = specs.get(cp.checkpoint)
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
        zoom: spec?.zoom ?? (cp.focus ? 1.5 : 1),
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
