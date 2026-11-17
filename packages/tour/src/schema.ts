/**
 * The tour file (`tour.json`): one narrated walk through a pull request, cut
 * from rrweb recordings of the app. The user's agent writes the captions, the
 * order and where to look; `pr2video tour check` validates it against this
 * schema, and the player and the renderer read it.
 *
 * Paths (`events`, `audio`) are relative to the tour file.
 */
import * as z from "zod"

export const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})
export type Box = z.infer<typeof boxSchema>

/**
 * What a scene points at: its box at the checkpoint (viewport pixels), and the
 * recorder's node id when one was read - the player then measures that very
 * node in the replay, so the box survives layout shifts.
 */
export const targetSchema = z.object({
  box: boxSchema,
  node: z.number().int().nullable().optional(),
})
export type Target = z.infer<typeof targetSchema>

export const MARK_TONES = ["added", "removed", "changed", "note"] as const
export type MarkTone = (typeof MARK_TONES)[number]

export const markerSchema = targetSchema.extend({
  label: z.string().nullable(),
  tone: z.enum(MARK_TONES),
})
export type Marker = z.infer<typeof markerSchema>

export const sceneSchema = z
  .object({
    id: z.string().min(1),
    /** A short label for the scene, e.g. "S1". */
    label: z.string().min(1),
    /** The recording's rrweb events (JSON array, optionally gzipped). */
    events: z.string().min(1),
    viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    /** The window, in the recording's own milliseconds. */
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    /** When the drive reached the checkpoint: the zoom and marks land here. */
    atMs: z.number().nonnegative(),
    /** When the checkpoint's screenshot was taken: the frame the scene holds on. */
    shotMs: z.number().nonnegative().nullable().optional(),
    caption: z.string().min(1),
    focus: targetSchema.nullable(),
    zoom: z.union([z.literal(1), z.literal(1.5), z.literal(2)], {
      error: "zoom is 1, 1.5 or 2",
    }),
    markers: z.array(markerSchema),
    /** The caption read aloud, when narrated. */
    audio: z.string().nullable().optional(),
    /** The narration's length; the scene holds until it ends. */
    audioMs: z.number().nonnegative().nullable().optional(),
  })
  .refine((s) => s.startMs <= s.atMs && s.atMs <= s.endMs, {
    message: "startMs <= atMs <= endMs must hold",
    path: ["atMs"],
  })
export type TourScene = z.infer<typeof sceneSchema>

export const tourSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string(),
  scenes: z.array(sceneSchema).min(1),
  /** Who read the captions aloud: a voice id such as "say" or "kokoro", or "none". */
  voice: z.string().default("none"),
  /** Which of the voice's speakers read them (a kokoro voice id, a `say -v` name, a Piper model). */
  speaker: z.string().nullable().optional(),
})
export type Tour = z.infer<typeof tourSchema>

export type TourProblem = { path: string; message: string }

/**
 * Every problem with a tour file, worded for the agent that wrote it: schema
 * errors plus the rules a schema cannot say. Empty means the tour is good.
 */
/** The most scenes a tour may have: past that it stops being a short demo. */
export const MAX_SCENES = 12

export function tourProblems(input: unknown): Array<TourProblem> {
  const parsed = tourSchema.safeParse(input)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }))
  const problems: Array<TourProblem> = []
  if (parsed.data.scenes.length > MAX_SCENES)
    problems.push({
      path: "scenes",
      message: `${parsed.data.scenes.length} scenes, at most ${MAX_SCENES}: drop the ones that add least (a "before" that shows nothing new, a step the next scene repeats)`,
    })
  const ids = new Set<string>()
  for (const [i, scene] of parsed.data.scenes.entries()) {
    const at = `scenes.${i}`
    if (ids.has(scene.id))
      problems.push({ path: `${at}.id`, message: `duplicate id "${scene.id}"` })
    ids.add(scene.id)
    const { width, height } = scene.viewport
    const outside = (box: Box) =>
      box.x + box.width < 0 || box.y + box.height < 0 || box.x > width || box.y > height
    if (scene.focus && outside(scene.focus.box))
      problems.push({ path: `${at}.focus`, message: "focus box lies outside the viewport" })
    for (const [m, marker] of scene.markers.entries())
      if (outside(marker.box))
        problems.push({
          path: `${at}.markers.${m}`,
          message: "marker box lies outside the viewport",
        })
    if (/^TODO\b/i.test(scene.caption.trim()))
      problems.push({
        path: `${at}.caption`,
        message: "write this caption: it is still the draft's TODO",
      })
    if (scene.caption.length > 280)
      problems.push({
        path: `${at}.caption`,
        message: "caption is over 280 characters; say one thing per scene",
      })
  }
  return problems
}

/**
 * What in a valid tour will not look the way it reads: a zoom that cannot
 * apply because its focus is too big to magnify and keep a margin (the player
 * never cuts the focus off), so the scene shows at a smaller zoom.
 */
/** The largest zoom up to `wanted` at which `box` still fits the viewport with a margin. */
/** Room the focus keeps around it once zoomed, as a share of the stage. */
const FIT_SHARE = 0.86
/** A zoom smaller than this reads as a jolt, not a zoom: the scene stays at 1. */
const MIN_ZOOM = 1.15

/**
 * How far a focus can be magnified in a viewport: `wanted`, or less when the
 * box would not fit at that size (the player zooms as far as it fits), or 1
 * when it cannot be magnified enough to notice.
 */
export function fitZoom(
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  wanted: number,
): number {
  if (!viewport.width || !viewport.height || !box.width || !box.height) return 1
  const most = Math.min(
    wanted,
    (viewport.width * FIT_SHARE) / box.width,
    (viewport.height * FIT_SHARE) / box.height,
  )
  return most >= MIN_ZOOM ? Math.round(most * 100) / 100 : 1
}

/**
 * The zoom level to write for a focus: `wanted`, unless the focus is too big
 * to magnify at all (then 1). Between the two the player zooms as far as fits.
 */
export function zoomThatFits(
  box: { width: number; height: number },
  viewport: { width: number; height: number },
  wanted: 1 | 1.5 | 2,
): 1 | 1.5 | 2 {
  if (wanted === 1) return 1
  const most = fitZoom(box, viewport, wanted)
  if (most === 1) return 1
  // 2 that only fits as 1.5 or less is written as 1.5, so the file says what shows.
  return wanted === 2 && most <= 1.5 ? 1.5 : wanted
}

export function tourWarnings(tour: Tour): Array<TourProblem> {
  const warnings: Array<TourProblem> = []
  for (const [i, scene] of tour.scenes.entries()) {
    if (!scene.focus || scene.zoom <= 1) continue
    const { width, height } = scene.focus.box
    // Zooming less than asked is what the player does anyway; only a zoom that
    // cannot happen at all is worth a word.
    if (fitZoom(scene.focus.box, scene.viewport, scene.zoom) > 1) continue
    warnings.push({
      path: `scenes.${i}.zoom`,
      message: `zoom ${scene.zoom} will show as 1: the focus (${Math.round(width)}x${Math.round(height)}) nearly fills ${scene.viewport.width}x${scene.viewport.height}; focus something smaller or set zoom 1`,
    })
  }
  return warnings
}
