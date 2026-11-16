/**
 * The tour's timeline, worked out from its scenes and paced the way a person
 * cuts a demo: each scene plays the drive up to its checkpoint (faster when it
 * is long), then stops on it - zooms in, shows the caption, marks what changed,
 * and holds there long enough to read or hear the explanation - before easing
 * out to the next. Also where to zoom, and the captions as WebVTT.
 *
 * Pure: the player and the renderer both draw what this returns, which is what
 * keeps the HTML tour and the MP4 frame for frame the same.
 */
import type { Box, TourScene } from "./schema.ts"

/** The longest a scene's approach takes on screen; a longer drive plays faster. */
export const APPROACH_MAX_MS = 4_000
/** The fastest an approach plays, so a long drive still reads as motion. */
export const APPROACH_MAX_SPEED = 4
/** The zoom easing in once the recording stops on the checkpoint. */
export const FOCUS_MS = 700
/** The zoom easing out before the next scene cuts in. */
export const RELEASE_MS = 500
/** The frame a scene stops on: just after the checkpoint, once the page has settled. */
export const SETTLE_AFTER_CHECKPOINT_MS = 400
/** How long after its checkpoint a screenshot can still be that checkpoint's. */
export const SHOT_WINDOW_MS = 3_000

type RrwebEvent = { timestamp: number; type?: number; data?: unknown }

/**
 * When the recorder took its screenshots, in the recording's milliseconds.
 * Playwright hides input carets for a screenshot by setting `caret-color:
 * transparent !important` on them, and rrweb records that: the first such
 * mutation of each burst is the moment the screenshot saw - the frame a scene
 * should stop on, rather than a guess after its checkpoint.
 *
 * rrweb writes that style two ways. On an element that already had an inline
 * style it records a diff, `{ "caret-color": ["transparent", "important"] }`,
 * and `false` when it goes; on one that had none it records the whole
 * attribute, `"caret-color: transparent !important;"`, and `""` after.
 */
export function screenshotMoments(events: ReadonlyArray<RrwebEvent>): Array<number> {
  const start = events[0]?.timestamp ?? 0
  const out: Array<number> = []
  // By node id, so a style another element changes meanwhile never ends a burst.
  const hidden = new Set<number | undefined>()
  for (const event of events) {
    const data = event.data as
      | {
          source?: number
          attributes?: Array<{ id?: number; attributes?: { style?: unknown } }>
        }
      | undefined
    if (event.type !== 3 || data?.source !== 0 || !data.attributes?.length) continue
    const burst = hidden.size === 0
    let hid = false
    for (const a of data.attributes) {
      const caret = caretOf(a.attributes?.style)
      if (caret === "hidden") {
        hidden.add(a.id)
        hid = true
      } else if (caret === "shown" || (caret === "other" && hidden.has(a.id))) hidden.delete(a.id)
    }
    if (hid && burst) out.push(event.timestamp - start)
  }
  return out
}

/**
 * What one recorded style change says about the caret: hidden by a
 * screenshot, shown again, some other style, or no style at all. A whole
 * attribute without the rule (`""` after a screenshot) is "other": the caller
 * counts it as shown only on an element it saw hidden.
 */
function caretOf(style: unknown): "hidden" | "shown" | "other" | null {
  if (typeof style === "string") {
    return /caret-color\s*:\s*transparent/i.test(style) ? "hidden" : "other"
  }
  if (!style || typeof style !== "object") return null
  const caret = (style as Record<string, unknown>)["caret-color"]
  if (Array.isArray(caret) && caret[0] === "transparent") return "hidden"
  if (caret === false) return "shown"
  return "other"
}

/** How long a scene holds after its narration ends, so a sentence is never cut. */
export const NARRATION_HOLD_MS = 600
/** A caption read in silence: about three words a second, plus a beat to find it. */
export const READING_WORDS_PER_SECOND = 3
export const READING_MIN_MS = 2_500
export const READING_MAX_MS = 12_000

/** How long a caption takes to read, without narration. */
export function readingMs(caption: string): number {
  const words = caption.trim().split(/\s+/).filter(Boolean).length
  const ms = (words / READING_WORDS_PER_SECOND) * 1_000 + 1_000
  return Math.round(Math.min(READING_MAX_MS, Math.max(READING_MIN_MS, ms)))
}

/** One scene's pacing: approach (the drive), focus (zooming in), hold (the explanation), release. */
export type ScenePace = {
  /** The recording's frame the scene stops on. */
  holdAtMs: number
  approachMs: number
  /** How fast the approach plays the recording. */
  speed: number
  focusMs: number
  holdMs: number
  releaseMs: number
}

/**
 * `untilMs` is the next checkpoint the tour shows on the same recording: a
 * screenshot from there on is that checkpoint's, not this one's. A scene whose
 * recorder noted its screenshot (`shotMs`) holds there, no guess.
 */
export function scenePace(
  scene: TourScene,
  narrationMs?: number | null,
  shots: ReadonlyArray<number> = [],
  untilMs: number | null = null,
): ScenePace {
  const before = Math.min(scene.endMs, untilMs ?? Number.POSITIVE_INFINITY)
  const shot =
    typeof scene.shotMs === "number" && scene.shotMs >= scene.atMs
      ? scene.shotMs
      : shots.find((ms) => ms >= scene.atMs && ms <= scene.atMs + SHOT_WINDOW_MS && ms < before)
  const settled = Math.min(scene.atMs + SETTLE_AFTER_CHECKPOINT_MS, before - 1)
  const holdAtMs = Math.max(
    scene.startMs,
    scene.atMs,
    Math.min(shot ?? settled, Math.max(scene.endMs, shot ?? 0)),
  )
  const span = holdAtMs - scene.startMs
  const speed = Math.min(APPROACH_MAX_SPEED, Math.max(1, span / APPROACH_MAX_MS))
  // Narration starts with the focus, so it is heard over the zoom and the hold.
  const holdMs = narrationMs
    ? Math.max(1_000, narrationMs + NARRATION_HOLD_MS - FOCUS_MS)
    : readingMs(scene.caption)
  return {
    holdAtMs,
    approachMs: Math.round(span / speed),
    speed,
    focusMs: FOCUS_MS,
    holdMs: Math.round(holdMs),
    releaseMs: RELEASE_MS,
  }
}

export type TimedScene = {
  scene: TourScene
  /** Where the scene starts on the tour's clock. */
  offsetMs: number
  durationMs: number
  pace: ScenePace
}

export type TourTimeline = { scenes: Array<TimedScene>; totalMs: number }

/**
 * `shots` is each recording's screenshot moments (`screenshotMoments`), by its
 * `events` path, once loaded: a scene then stops on its checkpoint's
 * screenshot. Narration lengths come from each scene's `audioMs`.
 */
export function tourTimeline(
  scenes: ReadonlyArray<TourScene>,
  shots: ReadonlyMap<string, ReadonlyArray<number>> = new Map(),
): TourTimeline {
  let offsetMs = 0
  const timed = scenes.map((scene) => {
    // The next checkpoint shown on this recording, whichever scene shows it.
    const later = scenes
      .filter((s) => s.events === scene.events && s.atMs > scene.atMs)
      .map((s) => s.atMs)
    const pace = scenePace(
      scene,
      scene.audio ? scene.audioMs : null,
      shots.get(scene.events),
      later.length ? Math.min(...later) : null,
    )
    const durationMs = pace.approachMs + pace.focusMs + pace.holdMs + pace.releaseMs
    const entry = { scene, offsetMs, durationMs, pace }
    offsetMs += durationMs
    return entry
  })
  return { scenes: timed, totalMs: offsetMs }
}

/** The scene playing at `ms`, and how far into it. */
export function sceneAt(timeline: TourTimeline, ms: number): { index: number; elapsedMs: number } {
  const at = Math.min(Math.max(0, ms), timeline.totalMs)
  for (const [index, entry] of timeline.scenes.entries()) {
    if (at < entry.offsetMs + entry.durationMs || index === timeline.scenes.length - 1)
      return { index, elapsedMs: Math.min(at - entry.offsetMs, entry.durationMs) }
  }
  return { index: 0, elapsedMs: 0 }
}

export type ScenePhase = "approach" | "focus" | "hold" | "release"

/** What the screen shows `elapsedMs` into a scene. */
export type SceneMoment = {
  phase: ScenePhase
  /** Where the recording is: moving during the approach, stopped on the checkpoint after. */
  recordingMs: number
  /** Whether the recording plays here (at `speed`) or is held still. */
  moving: boolean
  speed: number
  zoomed: boolean
  marked: boolean
  captioned: boolean
  /** How far into the narration, or null before it starts. */
  narrationMs: number | null
}

export function momentAt(entry: TimedScene, elapsedMs: number): SceneMoment {
  const { pace, scene } = entry
  const at = Math.max(0, elapsedMs)
  if (at < pace.approachMs) {
    return {
      phase: "approach",
      recordingMs: Math.min(scene.startMs + at * pace.speed, pace.holdAtMs),
      moving: true,
      speed: pace.speed,
      zoomed: false,
      marked: false,
      captioned: false,
      narrationMs: null,
    }
  }
  const sinceStop = at - pace.approachMs
  const phase: ScenePhase =
    sinceStop < pace.focusMs ? "focus" : sinceStop < pace.focusMs + pace.holdMs ? "hold" : "release"
  return {
    phase,
    recordingMs: pace.holdAtMs,
    moving: false,
    speed: pace.speed,
    zoomed: phase === "focus" || phase === "hold",
    // The marks land once the zoom has, so the eye is not chasing two things.
    marked: phase === "hold",
    captioned: true,
    narrationMs: sinceStop,
  }
}

/**
 * The transform that shows `box` magnified `zoom` times inside a `width` x
 * `height` stage, centred on it where the edges allow - never past them, so no
 * empty margin ever shows. All in stage pixels; apply with `transform-origin: 0 0`.
 */
export function zoomTransform(
  stage: { width: number; height: number },
  box: Box,
  zoom: number,
): { x: number; y: number; scale: number } {
  if (zoom <= 1 || !stage.width || !stage.height) return { x: 0, y: 0, scale: 1 }
  const windowW = stage.width / zoom
  const windowH = stage.height / zoom
  const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max)
  const left = clamp(box.x + box.width / 2 - windowW / 2, stage.width - windowW)
  const top = clamp(box.y + box.height / 2 - windowH / 2, stage.height - windowH)
  return { x: -left * zoom, y: -top * zoom, scale: zoom }
}

/**
 * How far to zoom so `box` stays in view: the most of `wanted`, 1.5 and 2 that
 * still leaves a margin round it, else 1. A scene with no focus asks for 2 and
 * zooms towards its marks; one that would barely magnify shows the page.
 */
export function fittedZoom(
  stage: { width: number; height: number },
  box: Box,
  wanted: number,
): number {
  if (!stage.width || !stage.height || !box.width || !box.height) return 1
  const fits = (zoom: number) =>
    box.width * zoom <= stage.width * 0.86 && box.height * zoom <= stage.height * 0.86
  for (const zoom of [2, 1.5]) if (zoom <= wanted && fits(zoom)) return zoom
  return 1
}

/** The smallest box around `boxes`; null for none. */
export function unionBox(boxes: ReadonlyArray<Box>): Box | null {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function vttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

/**
 * The captions as a WebVTT track on the tour's own clock: each cue from the
 * moment its scene stops on the checkpoint to the scene's end, as the player shows it.
 */
export function toVtt(timeline: TourTimeline): string {
  const cues = timeline.scenes.map(
    (entry, i) =>
      `${i + 1}\n${vttTime(entry.offsetMs + entry.pace.approachMs)} --> ${vttTime(entry.offsetMs + entry.durationMs)}\n${entry.scene.caption.replace(/\n+/g, " ")}`,
  )
  return `WEBVTT\n\n${cues.join("\n\n")}\n`
}

/**
 * Where each scene's narration starts on the tour's clock: with the focus,
 * right after the approach. The renderer mixes the audio tracks at these offsets.
 */
export function narrationOffsets(
  timeline: TourTimeline,
): Array<{ sceneId: string; audio: string; atMs: number }> {
  return timeline.scenes.flatMap((entry) =>
    entry.scene.audio
      ? [
          {
            sceneId: entry.scene.id,
            audio: entry.scene.audio,
            atMs: entry.offsetMs + entry.pace.approachMs,
          },
        ]
      : [],
  )
}
