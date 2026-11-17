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

async function pr2videoText(...args: Array<string>): Promise<string> {
  const { stdout } = await promisify(execFile)("node", [
    "--conditions=pr2video-source",
    cli,
    ...args,
  ])
  return stdout.trim()
}

describe("pr2video", () => {
  it("prints its version, the one the skill is written for", async () => {
    const version = await pr2videoText("--version")
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    expect(version).toBe(manifest.version)
    const skill = await readFile(join(await pr2videoText("skill", "path"), "SKILL.md"), "utf8")
    expect(skill).toContain(`npx -y pr2video@${version}\``)
  })

  it("installs the skill into a skills folder, and will not overwrite it unasked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-skill-"))
    await pr2videoText("skill", "install", dir)
    expect(await readFile(join(dir, "pr2video/SKILL.md"), "utf8")).toMatch(/^---\nname: pr2video\n/)
    expect(await readFile(join(dir, "pr2video/reference/tour.md"), "utf8")).toContain(
      "# Writing the tour",
    )
    const again = await pr2video("skill", "install", dir, "--json")
    expect(again.code).toBe(1)
    expect((again.json as { error: string }).error).toContain("--force")
    await pr2videoText("skill", "install", dir, "--force")
  })

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

  it("adds a before named in --before ahead of its head scene, and only then", async () => {
    const { keepWritten } = await import("../src/record-commands.ts")
    const draft = {
      version: 1 as const,
      title: "Draft",
      summary: "",
      voice: "none",
      scenes: [scene("a-before", "TODO before", 2_000), scene("a", "TODO", 4_000)],
    }
    const written = { version: 1, title: "Mine", summary: "", scenes: [scene("a", "Mine.", 1)] }
    expect(keepWritten(draft, written).tour.scenes.map((s) => s.id)).toEqual(["a"])
    const asked = keepWritten(draft, written, { addBefores: true })
    expect(asked.tour.scenes.map((s) => [s.id, s.caption])).toEqual([
      ["a-before", "TODO before"],
      ["a", "Mine."],
    ])
    expect(asked.added).toEqual(["a-before"])
    expect(asked.notInTour).toEqual([])
  })
})
