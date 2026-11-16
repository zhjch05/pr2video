import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

async function pr2video(...args: Array<string>): Promise<{ code: number; json: unknown }> {
  try {
    const { stdout } = await promisify(execFile)("node", [
      "--conditions=pr2video-source",
      cli,
      ...args,
    ])
    return { code: 0, json: JSON.parse(stdout) }
  } catch (error) {
    const failed = error as { code: number; stdout: string }
    return { code: failed.code, json: JSON.parse(failed.stdout) }
  }
}

describe("pr2video", () => {
  it("lists every voice, and none is always ready", async () => {
    const { code, json } = await pr2video("voices", "--json")
    expect(code).toBe(0)
    const voices = (json as { voices: Array<{ id: string; ok: boolean }> }).voices
    expect(voices.map((v) => v.id)).toEqual(["kokoro", "say", "piper", "espeak", "none"])
    expect(voices.find((v) => v.id === "none")?.ok).toBe(true)
  })

  it("checks a tour and exits 1 with its problems", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-cli-"))
    const path = join(dir, "tour.json")
    await writeFile(path, JSON.stringify({ version: 1, title: "T", summary: "", scenes: [] }))
    const { code, json } = await pr2video("tour", "check", path, "--json")
    expect(code).toBe(1)
    expect(json).toMatchObject({ ok: false, problems: [{ path: "scenes" }] })
  })
})

describe("pr2video render", () => {
  const demo = fileURLToPath(new URL("./fixtures/demo/tour.json", import.meta.url))

  it("writes one self-contained HTML file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-html-"))
    const out = join(dir, "tour.html")
    const { code, json } = await pr2video("render", demo, "--html", out, "--json")
    expect(code).toBe(0)
    expect(json).toMatchObject({ ok: true, html: { path: out } })
    const html = await readFile(out, "utf8")
    expect(html).toContain('id="pr2video-data"')
    expect(html).not.toMatch(/<script[^>]+src=/)
  })

  it.runIf(process.env.PR2VIDEO_TEST_MP4 === "1")(
    "renders an MP4 as long as the tour",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pr2video-mp4-"))
      const out = join(dir, "tour.mp4")
      const { code, json } = await pr2video(
        "render",
        demo,
        "--mp4",
        out,
        "--fps",
        "5",
        "--height",
        "200",
        "--json",
      )
      expect(code).toBe(0)
      const video = (json as { mp4: { durationMs: number; frames: number } }).mp4
      expect(video.frames).toBe(Math.ceil((video.durationMs / 1_000) * 5))
    },
    120_000,
  )
})

describe("shellCommand", () => {
  it("takes one argument as written and quotes an argv", async () => {
    const { shellCommand } = await import("../src/sandbox-commands.ts")
    expect(shellCommand(["npm ci && npm run build"])).toBe("npm ci && npm run build")
    expect(shellCommand(["sh", "-c", "echo one; echo two"])).toBe("sh -c 'echo one; echo two'")
    expect(shellCommand(["echo", "it's"])).toBe("echo 'it'\\''s'")
    expect(shellCommand(["node", "server.js", "--port=3001"])).toBe("node server.js --port=3001")
  })
})

describe("keepWritten", () => {
  const scene = (id: string, caption: string, atMs: number) => ({
    id,
    label: id.toUpperCase(),
    events: `head/${id}/events.json`,
    viewport: { width: 1280, height: 800 },
    startMs: 0,
    endMs: atMs + 1_000,
    atMs,
    caption,
    focus: null,
    zoom: 1 as const,
    markers: [],
  })

  it("keeps what was written and takes the recordings' timings", async () => {
    const { keepWritten } = await import("../src/record-commands.ts")
    const draft = {
      version: 1 as const,
      title: "Draft",
      summary: "",
      voice: "none",
      scenes: [scene("a", "TODO", 4_000), scene("b", "TODO", 5_000), scene("c", "TODO", 6_000)],
    }
    const written = {
      version: 1,
      title: "Mine",
      summary: "Why it matters.",
      scenes: [
        { ...scene("c", "C first.", 1), zoom: 2 },
        scene("a", "Then A.", 1),
        scene("gone", "Was recorded once.", 1),
      ],
    }
    const { tour, kept, notInTour, gone } = keepWritten(draft, written)
    expect(tour.title).toBe("Mine")
    expect(tour.scenes.map((s) => [s.id, s.caption, s.atMs, s.zoom])).toEqual([
      ["c", "C first.", 6_000, 2],
      ["a", "Then A.", 4_000, 1],
    ])
    expect({ kept, notInTour, gone }).toEqual({
      kept: ["c", "a"],
      notInTour: ["b"],
      gone: ["gone"],
    })
  })
})
