import { FOCUS_MS, type TourScene, tourTimeline } from "@pr2video/tour"
import { describe, expect, it } from "vitest"

import { embedJson, tourHtml } from "../src/data.ts"
import {
  captionSide,
  cubicBezier,
  easeTransform,
  frameAt,
  labelSpot,
  zoomEase,
} from "../src/frame.ts"

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

describe("captionSide", () => {
  const stage = { width: 1280, height: 800 }
  const none = { x: 0, y: 0, scale: 1 }

  it("stays at the bottom unless it would cover a box", () => {
    expect(captionSide(stage, none, [], 40)).toBe("bottom")
    expect(captionSide(stage, none, [{ x: 100, y: 100, width: 200, height: 40 }], 40)).toBe(
      "bottom",
    )
    expect(captionSide(stage, none, [{ x: 500, y: 740, width: 200, height: 40 }], 40)).toBe("top")
  })

  it("measures boxes where the zoom puts them", () => {
    // y 500..540 sits clear at scale 1; zoomed 1.5 from the top it lands at 750..810.
    const box = { x: 100, y: 500, width: 200, height: 40 }
    expect(captionSide(stage, none, [box], 40)).toBe("bottom")
    expect(captionSide(stage, { x: 0, y: 0, scale: 1.5 }, [box], 40)).toBe("top")
  })

  it("keeps the bottom when the top would cover more", () => {
    const boxes = [
      { x: 0, y: 760, width: 100, height: 20 },
      { x: 0, y: 0, width: 1280, height: 60 },
    ]
    expect(captionSide(stage, none, boxes, 40)).toBe("bottom")
  })
})

describe("labelSpot", () => {
  const bounds = { width: 1280, height: 800 }
  const mark = { x: 400, y: 300, width: 300, height: 40 }
  const label = { width: 80, height: 20 }

  it("goes above the mark when nothing is there", () => {
    expect(labelSpot(mark, label, [], bounds)).toEqual({ x: 0, y: -24 })
  })

  it("moves off a field's own label above it", () => {
    // The field's label text sits just above its left end, where the label would go.
    const fieldLabel = { x: 400, y: 270, width: 90, height: 20 }
    expect(labelSpot(mark, label, [fieldLabel], bounds)).toEqual({ x: 220, y: -24 })
  })

  it("goes below when the whole band above is taken, and beside when below is too", () => {
    const above = { x: 300, y: 260, width: 500, height: 36 }
    expect(labelSpot(mark, label, [above], bounds)).toEqual({ x: 0, y: 44 })
    const below = { x: 300, y: 344, width: 500, height: 30 }
    expect(labelSpot(mark, label, [above, below], bounds)).toEqual({ x: 304, y: 10 })
  })

  it("stays on the stage", () => {
    const top = { x: 10, y: 4, width: 300, height: 40 }
    expect(labelSpot(top, label, [], bounds)).toEqual({ x: 0, y: 44 })
  })

  it("takes the spot that covers least when every spot covers something", () => {
    const all = [{ x: 0, y: 0, width: 1280, height: 800 }]
    const small = [...all, { x: 400, y: 270, width: 90, height: 30, weight: 10 }]
    expect(labelSpot(mark, label, small, bounds)).toEqual({ x: 220, y: -24 })
  })
})
