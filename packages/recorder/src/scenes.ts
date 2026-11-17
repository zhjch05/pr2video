/**
 * The scenes file (`scenes.json`): what to film. The user's agent writes it
 * from the pull request; `pr2video scenes check` validates it, and the
 * recorder drives each scene in the sandbox's Chromium on the head (and then
 * the base) while rrweb records.
 *
 * A scene is a place in the app plus the state that shows the change: where
 * to start, a few steps from a closed vocabulary, and checkpoints to stop on.
 * No code: every step is data the recorder knows how to perform, so the same
 * scene replays on the base commit.
 */
import * as z from "zod"

/**
 * How to find an element, the way a person would describe it: by role and
 * accessible name, label, text, placeholder or test id. `css` is the escape
 * hatch when nothing semantic names it. `nth` picks one of several matches.
 */
export const locatorSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.string().optional(),
    testId: z.string().optional(),
    css: z.string().optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().nonnegative().optional(),
  })
  .refine(
    (l) =>
      [l.role, l.label, l.text, l.placeholder, l.testId, l.css].filter((v) => v !== undefined)
        .length === 1,
    { message: "give exactly one of role, label, text, placeholder, testId or css" },
  )
  .refine((l) => l.name === undefined || l.role !== undefined, {
    message: "name goes with role",
  })
export type Locator = z.infer<typeof locatorSchema>

export const MARK_TONES = ["added", "removed", "changed", "note"] as const

/** Something to point at on a checkpoint. */
export const markSchema = z.object({
  locator: locatorSchema,
  tone: z.enum(MARK_TONES),
  label: z.string().max(40).nullable().default(null),
})

export const checkpointSchema = z.object({
  checkpoint: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "lowercase letters, digits and -"),
  /** What a reviewer is looking at here and why it matters: the tour's caption. */
  caption: z.string().min(1).max(280),
  /** The element or section the caption is about; scrolled to the middle and zoomed towards. */
  // null is accepted as "no focus", as the tour file writes it.
  focus: locatorSchema.nullable().optional(),
  zoom: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
  marks: z.array(markSchema).max(4).default([]),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

const target = { on: locatorSchema }
export const actionSchema = z.union([
  z.object({ goto: z.string().min(1) }).strict(),
  z.object({ click: locatorSchema }).strict(),
  z.object({ hover: locatorSchema }).strict(),
  z.object({ fill: locatorSchema, value: z.string() }).strict(),
  z.object({ select: locatorSchema, value: z.string() }).strict(),
  z.object({ check: locatorSchema }).strict(),
  z.object({ uncheck: locatorSchema }).strict(),
  z
    .object({ press: z.string().min(1), ...target })
    .partial({ on: true })
    .strict(),
  z.object({ waitFor: locatorSchema }).strict(),
  z.object({ wait: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ scrollTo: locatorSchema }).strict(),
])
export type Action = z.infer<typeof actionSchema>

export const stepSchema = z.union([actionSchema, checkpointSchema])
export type Step = z.infer<typeof stepSchema>

export const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(240).max(2160),
})

export const sceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "lowercase letters, digits and -"),
  /** One line on what changed here. */
  title: z.string().min(1),
  /** Who is signed in: a key of `roles`, or none. */
  role: z.string().optional(),
  /** Where the scene starts, relative to `baseUrl`. */
  url: z.string().min(1),
  /** This scene's browser size, when it differs from the file's: a phone width for a responsive change. */
  viewport: viewportSchema.optional(),
  steps: z.array(stepSchema).min(1).max(16),
})
export type Scene = z.infer<typeof sceneSchema>

export const roleSchema = z.object({
  /** How this role signs in: run once, not recorded; its cookies and storage carry into its scenes. */
  steps: z.array(actionSchema).min(1).max(12),
})

export const scenesFileSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  /** Where the app answers inside the sandbox. */
  baseUrl: z.string().url(),
  viewport: viewportSchema.default({ width: 1280, height: 800 }),
  /** How long a step waits for its element before the scene stops. Raise it for a slow dev server. */
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  /**
   * Visit every scene's page once, unrecorded, before recording: a dev server
   * that compiles a page on its first visit then answers in time.
   */
  warmup: z.boolean().default(true),
  roles: z.record(z.string(), roleSchema).default({}),
  scenes: z.array(sceneSchema).min(1).max(8),
})
export type ScenesFile = z.infer<typeof scenesFileSchema>

export type ScenesProblem = { path: string; message: string }

const isCheckpoint = (step: Step): step is Checkpoint => "checkpoint" in step

/** Every problem with a scenes file, worded for the agent that wrote it. Empty means it is good. */
export function scenesProblems(input: unknown): Array<ScenesProblem> {
  const parsed = scenesFileSchema.safeParse(input)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }))
  const file = parsed.data
  const problems: Array<ScenesProblem> = []
  const ids = new Set<string>()
  for (const [i, scene] of file.scenes.entries()) {
    const at = `scenes.${i}`
    if (ids.has(scene.id))
      problems.push({ path: `${at}.id`, message: `duplicate id "${scene.id}"` })
    ids.add(scene.id)
    if (scene.role && !file.roles[scene.role])
      problems.push({ path: `${at}.role`, message: `no role "${scene.role}" in roles` })
    const checkpoints = scene.steps.filter(isCheckpoint)
    if (!checkpoints.length)
      problems.push({ path: `${at}.steps`, message: "a scene needs at least one checkpoint" })
    if (checkpoints.length > 6)
      problems.push({ path: `${at}.steps`, message: "at most 6 checkpoints per scene" })
    const names = new Set<string>()
    for (const cp of checkpoints) {
      if (names.has(cp.checkpoint))
        problems.push({ path: `${at}.steps`, message: `duplicate checkpoint "${cp.checkpoint}"` })
      names.add(cp.checkpoint)
    }
    if (scene.steps.length - checkpoints.length > 10)
      problems.push({ path: `${at}.steps`, message: "at most 10 actions per scene; split it" })
  }
  return problems
}

export { isCheckpoint }
