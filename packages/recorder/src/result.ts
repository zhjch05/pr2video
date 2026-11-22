/** What the recorder leaves for each scene, beside its rrweb events. */
import * as z from "zod"

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export const recordedTargetSchema = z.object({ box, node: z.number().nullable() })

export const recordedCheckpointSchema = z.object({
  checkpoint: z.string(),
  /** When the drive reached it, in the recording's ms (from its first event). */
  atMs: z.number(),
  /** When its screenshot was taken, in the recording's ms. */
  shotMs: z.number(),
  url: z.string(),
  /** Null when the scene gave no focus, or it was not on the page. */
  focus: recordedTargetSchema.nullable(),
  marks: z.array(
    recordedTargetSchema.extend({
      tone: z.enum(["added", "removed", "changed", "note"]),
      label: z.string().nullable(),
    }),
  ),
  /** Marks or a focus the page did not show, by their locator. */
  missing: z.array(z.string()),
  /** What may put the focus or a mark on the wrong thing (several matches, off-screen). */
  notes: z.array(z.string()).default([]),
  screenshot: z.string(),
})
export type RecordedCheckpoint = z.infer<typeof recordedCheckpointSchema>

export const sceneResultSchema = z.object({
  scene: z.string(),
  side: z.enum(["head", "base"]),
  /** shown: every checkpoint reached; partly: some; not-reached: none. */
  status: z.enum(["shown", "partly", "not-reached"]),
  viewport: z.object({ width: z.number(), height: z.number() }),
  /** The recording's length, in its own ms. */
  /** The recording's length, first event to last: a wait on a page that did not change adds nothing. */
  durationMs: z.number(),
  checkpoints: z.array(recordedCheckpointSchema),
  /** Where it stopped and why, when it did not finish. */
  error: z
    .object({
      step: z.number(),
      message: z.string(),
      url: z.string(),
      screenshot: z.string().nullable(),
    })
    .nullable(),
  events: z.string(),
})
export type SceneResult = z.infer<typeof sceneResultSchema>
