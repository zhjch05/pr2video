import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { tourProblems } from "@pr2video/tour"
import { describe, expect, it } from "vitest"

import { draftTour } from "../src/draft.ts"
import { scenesFileSchema, scenesProblems } from "../src/scenes.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scenesFile = async () => JSON.parse(await readFile(`${fixtures}scenes.json`, "utf8"))

describe("scenesProblems", () => {
  it("accepts the sample scenes", async () => {
    expect(scenesProblems(await scenesFile())).toEqual([])
  })

  it("names each problem by path", async () => {
    const file = await scenesFile()
    file.scenes.push({ ...file.scenes[0], role: "admin", steps: [{ click: { role: "button" } }] })
    expect(scenesProblems(file)).toEqual([
      { path: "scenes.1.id", message: 'duplicate id "dark-mode"' },
      { path: "scenes.1.role", message: 'no role "admin" in roles' },
      { path: "scenes.1.steps", message: "a scene needs at least one checkpoint" },
    ])
  })

  it("refuses a locator that names two ways to find it, and unknown actions", async () => {
    const file = await scenesFile()
    file.scenes[0].steps.unshift({ click: { role: "link", text: "Settings" } })
    file.scenes[0].steps.unshift({ drag: { css: "a" } })
    const problems = scenesProblems(file)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((p) => p.path.startsWith("scenes.0.steps."))).toBe(true)
  })
})

describe("draftTour", () => {
  it("makes one tour scene per checkpoint, windowed and valid", async () => {
    const { tour, skipped } = await draftTour({
      scenes: scenesFileSchema.parse(await scenesFile()),
      recordings: `${fixtures}head`,
      tourDir: fixtures,
    })
    expect(skipped).toEqual([])
    expect(tour.scenes.map((s) => s.id)).toEqual(["dark-mode-switch", "dark-mode-on"])
    const [first, second] = tour.scenes
    expect(first?.events).toBe("head/dark-mode/events.json")
    expect(first?.zoom).toBe(2)
    expect(first?.markers[0]?.tone).toBe("added")
    // The second scene starts where the first one's screenshot was.
    expect(second?.startMs).toBe(first?.shotMs)
    expect(second?.focus).toBeNull()
    expect(tourProblems(tour)).toEqual([])
  })

  it("leaves out a scene that was never recorded", async () => {
    const file = scenesFileSchema.parse(await scenesFile())
    const [first] = file.scenes
    if (!first) throw new Error("the fixture has no scene")
    const missing = { ...file, scenes: [...file.scenes, { ...first, id: "other" }] }
    const { skipped } = await draftTour({
      scenes: missing,
      recordings: `${fixtures}head`,
      tourDir: fixtures,
    })
    expect(skipped).toEqual([{ scene: "other", reason: "not recorded" }])
  })
})
