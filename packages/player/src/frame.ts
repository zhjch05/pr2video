/**
 * What the player shows at tour time `t`, as a pure function of `t`: the
 * scene, its moment (`momentAt`), and how far the zoom has eased in. Both the
 * interactive player and the frame-by-frame renderer draw exactly this, so an
 * MP4 and the HTML tour show the same frame at the same time.
 *
 * The zoom is computed, not a CSS transition: a transition runs on the wall
 * clock, which a renderer stepping through frames does not follow.
 */
import {
  FOCUS_MS,
  momentAt,
  RELEASE_MS,
  type SceneMoment,
  sceneAt,
  type TimedScene,
  type TourTimeline,
} from "@pr2video/tour"

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` as a function of progress in [0, 1]:
 * solve x(s) = p for the curve parameter s (Newton, then bisection), return y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s ** 2
  return (p: number): number => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let s = p
    for (let i = 0; i < 8; i++) {
      const dx = at(x1, x2, s) - p
      if (Math.abs(dx) < 1e-6) return at(y1, y2, s)
      const d = slope(x1, x2, s)
      if (Math.abs(d) < 1e-6) break
      s -= dx / d
    }
    let lo = 0
    let hi = 1
    s = p
    for (let i = 0; i < 30; i++) {
      const x = at(x1, x2, s)
      if (Math.abs(x - p) < 1e-6) break
      if (x < p) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return at(y1, y2, s)
  }
}

/** The zoom's easing: a quick start that settles gently, as a person zooms a demo. */
export const zoomEase = cubicBezier(0.22, 1, 0.36, 1)

/** How far the zoom is in, 0 (the whole page) to 1 (the scene's zoom), `moment` into a scene. */
export function zoomProgress(entry: TimedScene, moment: SceneMoment): number {
  if (moment.phase === "approach" || moment.narrationMs === null) return 0
  const sinceStop = moment.narrationMs
  if (moment.phase === "focus") return zoomEase(sinceStop / FOCUS_MS)
  if (moment.phase === "hold") return 1
  const intoRelease = sinceStop - entry.pace.focusMs - entry.pace.holdMs
  return 1 - zoomEase(intoRelease / RELEASE_MS)
}

export type FrameState = {
  index: number
  entry: TimedScene
  moment: SceneMoment
  /** 0..1, how far the zoom has eased towards the scene's target. */
  zoom: number
}

export function frameAt(timeline: TourTimeline, t: number): FrameState | null {
  const { index, elapsedMs } = sceneAt(timeline, t)
  const entry = timeline.scenes[index]
  if (!entry) return null
  const moment = momentAt(entry, elapsedMs)
  return { index, entry, moment, zoom: zoomProgress(entry, moment) }
}

/** A transform eased `p` of the way from none to `target`, as CSS interpolates translate and scale. */
export function easeTransform(
  target: { x: number; y: number; scale: number },
  p: number,
): { x: number; y: number; scale: number } {
  return { x: target.x * p, y: target.y * p, scale: 1 + (target.scale - 1) * p }
}

type Rect = { x: number; y: number; width: number; height: number; weight?: number }

/**
 * Where the caption goes so it does not cover what the scene is about: the
 * bottom, unless a box (stage pixels, before `transform`) would sit under it
 * once zoomed; then the top, unless that covers more. A box's `weight`
 * (default 1) scales how much covering it counts.
 */
export function captionSide(
  stage: { width: number; height: number },
  transform: { x: number; y: number; scale: number },
  boxes: ReadonlyArray<Rect>,
  captionHeight: number,
  margin = 12,
): "top" | "bottom" {
  const band = captionHeight + margin * 2
  const covered = (top: number, bottom: number) =>
    boxes.reduce((sum, box) => {
      const y0 = Math.max(0, box.y * transform.scale + transform.y)
      const y1 = Math.min(stage.height, (box.y + box.height) * transform.scale + transform.y)
      const width =
        Math.min(stage.width, (box.x + box.width) * transform.scale + transform.x) -
        Math.max(0, box.x * transform.scale + transform.x)
      const overlap = Math.min(y1, bottom) - Math.max(y0, top)
      return sum + (overlap > 0 && width > 0 ? overlap * width * (box.weight ?? 1) : 0)
    }, 0)
  const atBottom = covered(stage.height - band, stage.height)
  if (atBottom === 0) return "bottom"
  return covered(0, band) < atBottom ? "top" : "bottom"
}
