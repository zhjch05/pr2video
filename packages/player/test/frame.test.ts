import { FOCUS_MS, type TourScene, tourTimeline } from "@pr2video/tour"
import { describe, expect, it } from "vitest"

import { embedJson, tourHtml } from "../src/data.ts"
import { cubicBezier, easeTransform, frameAt, zoomEase } from "../src/frame.ts"

const scene: TourScene = {
  id: "s1",
  label: "S1",
  events: "r.json",
  viewport: { width: 1280, height: 800 },
  startMs: 0,
  endMs: 5_000,
  atMs: 2_000,
  caption: "A caption.",
  focus: null,
  zoom: 1,
  markers: [],
}

describe("cubicBezier", () => {
  it("starts at 0, ends at 1 and never goes back", () => {
    expect(zoomEase(0)).toBe(0)
    expect(zoomEase(1)).toBe(1)
    let last = 0
    for (let p = 0.05; p < 1; p += 0.05) {
      const y = zoomEase(p)
      expect(y).toBeGreaterThanOrEqual(last)
      last = y
    }
  })

  it("is the identity for a linear curve", () => {
    expect(cubicBezier(0.25, 0.25, 0.75, 0.75)(0.4)).toBeCloseTo(0.4, 4)
  })
})

describe("frameAt", () => {
  const timeline = tourTimeline([scene])

  it("is not zoomed during the approach, and fully zoomed in the hold", () => {
    expect(frameAt(timeline, 1_000)?.zoom).toBe(0)
    const stop = timeline.scenes[0]?.pace.approachMs ?? 0
    expect(frameAt(timeline, stop + FOCUS_MS / 2)?.zoom).toBeGreaterThan(0.5)
    expect(frameAt(timeline, stop + FOCUS_MS + 10)?.zoom).toBe(1)
    expect(frameAt(timeline, timeline.totalMs)?.zoom).toBeCloseTo(0, 5)
  })

  it("eases a transform from none", () => {
    expect(easeTransform({ x: -100, y: -50, scale: 2 }, 0.5)).toEqual({
      x: -50,
      y: -25,
      scale: 1.5,
    })
  })
})

describe("tourHtml", () => {
  it("keeps the data from closing its script tag", () => {
    expect(embedJson({ caption: "</script><b>" })).not.toContain("</script")
    const html = tourHtml(
      {
        tour: { version: 1, title: "A <b> tour", summary: "", scenes: [scene], voice: "none" },
        events: {},
        audio: {},
        shots: {},
      },
      { js: "console.log('</script>')", css: "" },
    )
    expect(html).toContain("<title>A &lt;b&gt; tour</title>")
    expect(html.match(/<\/script>/g)?.length).toBe(2)
  })
})
