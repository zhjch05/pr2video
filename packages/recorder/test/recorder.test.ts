import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { crc32, deflateSync } from "node:zlib"

import { tourProblems } from "@pr2video/tour"
import { describe, expect, it } from "vitest"

import { draftTour } from "../src/draft.ts"
import { decodePng, pixelDifference } from "../src/png.ts"
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

/** An RGB PNG of `width` x `height`, every row run through PNG filter `filter`. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[], filter = 0) {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length)
    head.write(type, 4, "latin1")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const rows: Array<number> = []
  for (let y = 0; y < height; y++) {
    rows.push(filter)
    for (let x = 0; x < width; x++) {
      const here = pixel(x, y)
      // Filter 1 (Sub) stores each byte minus the one a pixel to its left.
      const left = filter === 1 && x > 0 ? pixel(x - 1, y) : [0, 0, 0]
      rows.push(...here.map((v, k) => (v - (left[k] ?? 0) + 256) & 0xff))
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

describe("png", () => {
  const gradient = (x: number, y: number) => [x * 10, y * 20, 128]

  it("decodes what it is given, through the row filters", () => {
    const plain = decodePng(png(8, 4, gradient))
    const filtered = decodePng(png(8, 4, gradient, 1))
    expect(plain).toMatchObject({ width: 8, height: 4, channels: 3 })
    expect([...plain.data.subarray(3 * 9, 3 * 9 + 3)]).toEqual([10, 20, 128])
    expect(pixelDifference(plain, filtered)).toBe(0)
  })

  it("counts the pixels that differ visibly", () => {
    const a = decodePng(png(10, 10, () => [255, 255, 255]))
    const b = decodePng(png(10, 10, (x, y) => (x === 0 && y < 5 ? [0, 0, 0] : [250, 250, 250])))
    expect(pixelDifference(a, b)).toBe(0.05)
    expect(pixelDifference(a, decodePng(png(5, 5, () => [0, 0, 0])))).toBe(1)
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

  it("with base recordings, shows each checkpoint the base reached before it, caption to write", async () => {
    const { tour } = await draftTour({
      scenes: scenesFileSchema.parse(await scenesFile()),
      recordings: `${fixtures}head`,
      tourDir: fixtures,
      base: `${fixtures}base`,
    })
    expect(tour.scenes.map((s) => s.id)).toEqual([
      "dark-mode-switch-before",
      "dark-mode-switch",
      "dark-mode-on",
    ])
    expect(tour.scenes[0]?.events).toBe("base/dark-mode/events.json")
    expect(tourProblems(tour)).toEqual([
      { path: "scenes.0.caption", message: "write this caption: it is still the draft's TODO" },
    ])
  })

  it("leaves out a before scene whose screenshot looks the same as the head's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-draft-"))
    await cp(fixtures, dir, { recursive: true })
    const same = png(4, 4, () => [200, 200, 200])
    await writeFile(join(dir, "head/dark-mode/switch.png"), same)
    await writeFile(join(dir, "base/dark-mode/switch.png"), same)
    const { tour, skipped } = await draftTour({
      scenes: scenesFileSchema.parse(await scenesFile()),
      recordings: join(dir, "head"),
      tourDir: dir,
      base: join(dir, "base"),
    })
    expect(tour.scenes.map((s) => s.id)).toEqual(["dark-mode-switch", "dark-mode-on"])
    expect(skipped).toEqual([
      { scene: "dark-mode-switch-before", reason: "the base looks the same at this checkpoint" },
    ])
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
