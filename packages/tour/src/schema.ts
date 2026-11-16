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
    zoom: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
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
})
export type Tour = z.infer<typeof tourSchema>

export type TourProblem = { path: string; message: string }

/**
 * Every problem with a tour file, worded for the agent that wrote it: schema
 * errors plus the rules a schema cannot say. Empty means the tour is good.
 */
export function tourProblems(input: unknown): Array<TourProblem> {
  const parsed = tourSchema.safeParse(input)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }))
  const problems: Array<TourProblem> = []
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
    if (scene.caption.length > 280)
      problems.push({
        path: `${at}.caption`,
        message: "caption is over 280 characters; say one thing per scene",
      })
  }
  return problems
}
