import { describe, expect, it } from "vitest"

import { fitZoom, type TourScene, tourProblems, tourWarnings } from "../src/schema.ts"
import {
  APPROACH_MAX_MS,
  FOCUS_MS,
  momentAt,
  NARRATION_HOLD_MS,
  narrationOffsets,
  READING_MIN_MS,
  RELEASE_MS,
  readingMs,
  sceneAt,
  screenshotMoments,
  tourTimeline,
  toVtt,
  zoomTransform,
} from "../src/timeline.ts"

function scene(overrides: Partial<TourScene> = {}): TourScene {
  return {
    id: "s1",
    label: "S1",
    events: "recordings/s1.json",
    viewport: { width: 1280, height: 800 },
    startMs: 0,
    endMs: 5_000,
    atMs: 2_000,
    caption: "The cart now shows each supplier's total.",
    focus: { box: { x: 100, y: 100, width: 200, height: 80 } },
    zoom: 2,
    markers: [],
    ...overrides,
  }
}

describe("tourTimeline", () => {
  it("paces a silent scene by reading time", () => {
    const timeline = tourTimeline([scene()])
    const [entry] = timeline.scenes
    expect(entry?.pace.holdAtMs).toBe(2_400)
    expect(entry?.pace.speed).toBe(1)
    expect(entry?.pace.holdMs).toBe(readingMs(scene().caption))
    expect(timeline.totalMs).toBe(2_400 + FOCUS_MS + readingMs(scene().caption) + RELEASE_MS)
    expect(readingMs("Hi")).toBe(READING_MIN_MS)
  })

  it("holds a narrated scene until the narration ends", () => {
    const timeline = tourTimeline([scene({ audio: "audio/s1.mp3", audioMs: 5_000 })])
    expect(timeline.scenes[0]?.pace.holdMs).toBe(5_000 + NARRATION_HOLD_MS - FOCUS_MS)
  })

  it("speeds up a long approach, capped", () => {
    const timeline = tourTimeline([scene({ atMs: 40_000, endMs: 41_000 })])
    const pace = timeline.scenes[0]?.pace
    expect(pace?.speed).toBe(4)
    expect(pace?.approachMs).toBeGreaterThan(APPROACH_MAX_MS)
  })

  it("chains offsets and starts narration with the focus", () => {
    const a = scene({ id: "a", audio: "a.mp3", audioMs: 1_000 })
    const b = scene({ id: "b", events: "recordings/s2.json", audio: "b.mp3", audioMs: 1_000 })
    const timeline = tourTimeline([a, b])
    const second = timeline.scenes[1]
    expect(second?.offsetMs).toBe(timeline.scenes[0]?.durationMs)
    const offsets = narrationOffsets(timeline)
    expect(offsets.map((o) => o.atMs)).toEqual([
      2_400,
      (second?.offsetMs ?? 0) + (second?.pace.approachMs ?? 0),
    ])
  })

  it("never holds on a later checkpoint's screenshot", () => {
    const first = scene({ id: "a", atMs: 1_000, endMs: 5_000 })
    const second = scene({ id: "b", atMs: 1_200, endMs: 5_000 })
    const shots = new Map([["recordings/s1.json", [1_300]]])
    const timeline = tourTimeline([first, second], shots)
    expect(timeline.scenes[0]?.pace.holdAtMs).toBe(1_199)
    expect(timeline.scenes[1]?.pace.holdAtMs).toBe(1_300)
  })
})

describe("moments", () => {
  it("moves during the approach and zooms, marks and captions after", () => {
    const timeline = tourTimeline([scene()])
    const entry = timeline.scenes[0]
    if (!entry) throw new Error("no scene")
    expect(momentAt(entry, 100)).toMatchObject({ phase: "approach", moving: true, zoomed: false })
    expect(momentAt(entry, 2_400 + 100)).toMatchObject({
      phase: "focus",
      zoomed: true,
      marked: false,
    })
    expect(momentAt(entry, 2_400 + FOCUS_MS + 10)).toMatchObject({ phase: "hold", marked: true })
    expect(sceneAt(timeline, timeline.totalMs + 99).index).toBe(0)
  })
})

describe("zoomTransform", () => {
  it("clamps to the stage edges", () => {
    const t = zoomTransform({ width: 1000, height: 500 }, { x: 0, y: 0, width: 10, height: 10 }, 2)
    expect(t).toEqual({ x: -0, y: -0, scale: 2 })
  })
})

describe("screenshotMoments", () => {
  it("finds the caret-hiding burst in both of rrweb's spellings", () => {
    const events = [
      { timestamp: 1_000, type: 4 },
      {
        timestamp: 1_500,
        type: 3,
        data: {
          source: 0,
          attributes: [
            { id: 7, attributes: { style: { "caret-color": ["transparent", "important"] } } },
          ],
        },
      },
      {
        timestamp: 1_600,
        type: 3,
        data: {
          source: 0,
          attributes: [{ id: 7, attributes: { style: { "caret-color": false } } }],
        },
      },
      {
        timestamp: 2_500,
        type: 3,
        data: {
          source: 0,
          attributes: [{ id: 9, attributes: { style: "caret-color: transparent !important;" } }],
        },
      },
    ]
    expect(screenshotMoments(events)).toEqual([500, 1_500])
  })
})

describe("toVtt", () => {
  it("writes one cue per scene from the stop", () => {
    expect(toVtt(tourTimeline([scene()]))).toContain("00:00:02.400 -->")
  })
})

describe("tourProblems", () => {
  it("accepts a good tour and names what is wrong with a bad one", () => {
    const good = { version: 1, title: "T", summary: "", scenes: [scene()] }
    expect(tourProblems(good)).toEqual([])
    const bad = {
      ...good,
      scenes: [scene(), scene({ focus: { box: { x: 5_000, y: 0, width: 1, height: 1 } } })],
    }
    expect(tourProblems(bad).map((p) => p.message)).toEqual([
      'duplicate id "s1"',
      "focus box lies outside the viewport",
    ])
    expect(tourProblems({ version: 1 }).length).toBeGreaterThan(0)
  })

  it("names the zooms there are", () => {
    const tour = { version: 1, title: "T", summary: "", scenes: [{ ...scene(), zoom: 1.3 }] }
    expect(tourProblems(tour)).toEqual([{ path: "scenes.0.zoom", message: "zoom is 1, 1.5 or 2" }])
  })

  it("holds a tour to 12 scenes", () => {
    const scenes = Array.from({ length: 13 }, (_, i) => scene({ id: `s${i}` }))
    const problems = tourProblems({ version: 1, title: "T", summary: "", scenes })
    expect(problems.map((p) => p.path)).toEqual(["scenes"])
    expect(problems[0]?.message).toContain("13 scenes, at most 12")
  })
})

describe("fitZoom", () => {
  const view = { width: 1280, height: 800 }
  it("gives what was asked when the focus fits", () => {
    expect(fitZoom({ width: 400, height: 200 }, view, 1.5)).toBe(1.5)
  })
  it("zooms as far as fits when the asked zoom would overflow", () => {
    // 748 * 1.5 = 1122 is wider than 86% of 1280: 1.47 still fits.
    expect(fitZoom({ width: 748, height: 389 }, view, 1.5)).toBe(1.47)
  })
  it("stays at 1 when the focus could barely be magnified", () => {
    expect(fitZoom({ width: 1000, height: 300 }, view, 1.5)).toBe(1)
  })
})

describe("tourWarnings", () => {
  const scene = (labels: Array<string | null>) =>
    ({
      id: "s",
      label: "S1",
      events: "e.json",
      viewport: { width: 1280, height: 800 },
      startMs: 0,
      endMs: 2_000,
      atMs: 1_000,
      caption: "A caption.",
      focus: null,
      zoom: 1,
      markers: labels.map((label) => ({
        box: { x: 0, y: 0, width: 10, height: 10 },
        label,
        tone: "added",
      })),
    }) as unknown as TourScene
  const tour = (labels: Array<string | null>) =>
    ({ version: 1, title: "T", summary: "", scenes: [scene(labels)] }) as never

  it("asks for labels when a scene has two or more marks", () => {
    expect(tourWarnings(tour(["New", null])).map((w) => w.path)).toEqual(["scenes.0.markers"])
    expect(tourWarnings(tour(["New", "Old"]))).toEqual([])
    expect(tourWarnings(tour([null]))).toEqual([])
  })
})
