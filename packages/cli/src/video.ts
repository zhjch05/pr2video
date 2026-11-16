/**
 * The tour as an MP4, rendered frame by frame rather than screen-recorded:
 * headless Chromium opens the same page as the HTML tour in render mode,
 * draws each frame at its exact tour time (`window.pr2video.seek`), and ffmpeg
 * encodes the screenshots. The narration is then mixed in at the times the
 * timeline starts each clip. Slower than recording the screen, but no frame
 * is ever dropped or late, and the video matches the HTML tour.
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { narrationOffsets, tourTimeline } from "@pr2video/tour"

import { buildHtml } from "./assemble.ts"

export type VideoOptions = {
  /** Frames per second. */
  fps?: number | undefined
  /** Output height in pixels; the width follows the recording's shape. */
  height?: number | undefined
  /** JPEG quality of each captured frame, 1-100. */
  quality?: number | undefined
  /** x264 constant rate factor: lower is better and bigger. */
  crf?: number | undefined
  log?: ((line: string) => void) | undefined
}

/** What the tour page exposes in render mode (`@pr2video/player`'s entry). */
type PageGlobals = {
  pr2video?: { totalMs: number; seek(ms: number): Promise<void> }
  pr2videoError?: string
}

type Encoder = { write(frame: Buffer): Promise<void>; finish(): Promise<void> }

function ffmpegEncoder(args: ReadonlyArray<string>): Encoder {
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000)
  })
  const exited = new Promise<void>((done, fail) => {
    child.on("error", fail)
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    )
  })
  return {
    write: (frame) =>
      new Promise((done, fail) => {
        if (child.stdin.write(frame)) done()
        else child.stdin.once("drain", done)
        child.stdin.once("error", fail)
      }),
    finish: async () => {
      child.stdin.end()
      await exited
    },
  }
}

function runFfmpeg(args: ReadonlyArray<string>): Promise<void> {
  const encoder = ffmpegEncoder(args)
  return encoder.finish()
}

async function launchChromium() {
  let playwright: typeof import("playwright")
  try {
    playwright = await import("playwright")
  } catch {
    throw new Error("rendering an MP4 needs Playwright: npm install playwright")
  }
  try {
    return await playwright.chromium.launch({ headless: true })
  } catch (error) {
    throw new Error(
      `cannot start Chromium (${(error as Error).message.split("\n")[0]}); run: npx playwright install chromium`,
    )
  }
}

export async function renderVideo(
  tourPath: string,
  outPath: string,
  options: VideoOptions = {},
): Promise<{ path: string; frames: number; durationMs: number; width: number; height: number }> {
  const fps = options.fps ?? 30
  const log = options.log ?? (() => undefined)
  const { html, data } = await buildHtml(tourPath)
  const timeline = tourTimeline(data.tour.scenes, new Map(Object.entries(data.shots)))
  const first = data.tour.scenes[0]
  if (!first) throw new Error("the tour has no scenes")
  const viewport = first.viewport
  // The page is the recording's size; the device scale sets the output's.
  const scale = (options.height ?? 1080) / viewport.height
  const width = Math.round((viewport.width * scale) / 2) * 2
  const height = Math.round((viewport.height * scale) / 2) * 2

  const work = await mkdtemp(join(tmpdir(), "pr2video-render-"))
  const browser = await launchChromium()
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale })
    const htmlPath = join(work, "tour.html")
    await writeFile(htmlPath, html)
    await page.goto(`${pathToFileURL(htmlPath).href}?render`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () =>
        (globalThis as unknown as PageGlobals).pr2video ||
        (globalThis as unknown as PageGlobals).pr2videoError,
      null,
      { timeout: 60_000 },
    )
    const failed = await page.evaluate(() => (globalThis as unknown as PageGlobals).pr2videoError)
    if (failed) throw new Error(`the player failed: ${failed}`)

    const silent = join(work, "video.mp4")
    const encoder = ffmpegEncoder([
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "mjpeg",
      "-i",
      "-",
      "-vf",
      `scale=${width}:${height}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      String(options.crf ?? 18),
      "-pix_fmt",
      "yuv420p",
      silent,
    ])
    const frames = Math.ceil((timeline.totalMs / 1_000) * fps)
    const started = Date.now()
    for (let i = 0; i < frames; i++) {
      const t = (i * 1_000) / fps
      await page.evaluate((ms) => (globalThis as unknown as PageGlobals).pr2video?.seek(ms), t)
      await encoder.write(await page.screenshot({ type: "jpeg", quality: options.quality ?? 92 }))
      if (i % fps === 0 || i === frames - 1)
        log(`frame ${i + 1}/${frames} (${((Date.now() - started) / 1_000).toFixed(0)}s)`)
    }
    await encoder.finish()

    const clips = narrationOffsets(timeline).filter((clip) => data.audio[clip.audio])
    const out = resolve(outPath)
    if (!clips.length) {
      await runFfmpeg([
        "-y",
        "-loglevel",
        "error",
        "-i",
        silent,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        out,
      ])
    } else {
      log(`mixing ${clips.length} narration clips`)
      const inputs = clips.flatMap((clip) => ["-i", join(dirname(tourPath), clip.audio)])
      const delayed = clips.map(
        (clip, i) =>
          `[${i + 1}:a]aresample=48000,adelay=delays=${Math.round(clip.atMs)}:all=1[a${i}]`,
      )
      const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad[narration]`
      await runFfmpeg([
        "-y",
        "-loglevel",
        "error",
        "-i",
        silent,
        ...inputs,
        "-filter_complex",
        [...delayed, mix].join(";"),
        "-map",
        "0:v",
        "-map",
        "[narration]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        out,
      ])
    }
    return { path: out, frames, durationMs: timeline.totalMs, width, height }
  } finally {
    await browser.close()
    await rm(work, { recursive: true, force: true })
  }
}
