import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { clipKey, narrateTour } from "../src/narrate.ts"
import { VOICES } from "../src/voices.ts"
import { encodeWav, wavDurationMs } from "../src/wav.ts"

describe("wav", () => {
  it("measures what it encodes", () => {
    const wav = encodeWav(new Float32Array(24_000 * 1.5), 24_000)
    expect(wavDurationMs(wav)).toBe(1_500)
  })

  it("rejects what is not WAV", () => {
    expect(() => wavDurationMs(new Uint8Array(40))).toThrow("not a WAV file")
  })
})

describe("clipKey", () => {
  it("changes with the caption and the speaker", () => {
    expect(clipKey("say", "a")).not.toBe(clipKey("say", "b"))
    expect(clipKey("say", "a")).not.toBe(clipKey("say", "a", { speaker: "Samantha" }))
  })
})

async function tourFile() {
  const dir = await mkdtemp(join(tmpdir(), "pr2video-test-"))
  const path = join(dir, "tour.json")
  const scene = {
    id: "s1",
    label: "S1",
    events: "recordings/s1.json",
    viewport: { width: 1280, height: 800 },
    startMs: 0,
    endMs: 3_000,
    atMs: 1_000,
    caption: "The settings page now has a dark mode switch.",
    focus: null,
    zoom: 1,
    markers: [],
  }
  await writeFile(path, JSON.stringify({ version: 1, title: "T", summary: "", scenes: [scene] }))
  return path
}

describe("narrateTour", () => {
  it("removes narration with the none voice", async () => {
    const path = await tourFile()
    const { tour } = await narrateTour(path, "none")
    expect(tour.voice).toBe("none")
    expect(tour.scenes[0]?.audio).toBeNull()
  })

  it.runIf(process.platform === "darwin")("speaks with say, then reuses the clip", async () => {
    const path = await tourFile()
    const first = await narrateTour(path, "say")
    expect(first.spoken).toBe(1)
    const scene = first.tour.scenes[0]
    expect(scene?.audio).toMatch(/^audio\/[0-9a-f]{12}\.(mp3|wav)$/)
    expect(scene?.audioMs).toBeGreaterThan(1_000)
    const again = await narrateTour(path, "say")
    expect(again).toMatchObject({ spoken: 0, reused: 1 })
    expect(JSON.parse(await readFile(path, "utf8")).voice).toBe("say")
  })

  it("names how to install a voice that is missing", async () => {
    const piper = await VOICES.piper.available({})
    if (!piper.ok) expect(piper.install).toContain("piper")
  })
})
