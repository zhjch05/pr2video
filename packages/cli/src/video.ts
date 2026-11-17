/**
 * The tour as an MP4, rendered frame by frame rather than screen-recorded:
 * headless Chromium opens the same page as the HTML tour in render mode,
 * draws each frame at its exact tour time (`window.pr2video.seek`), and ffmpeg
 * encodes the screenshots. The narration is then mixed in at the times the
 * timeline starts each clip. No frame is ever dropped or late, and the video
 * matches the HTML tour. The frames are split between several pages, each
 * encoding its own stretch, and the stretches are joined without re-encoding.
 */

import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { availableParallelism, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { narrationOffsets, tourTimeline } from "@pr2video/tour"
import { importInstalled } from "@pr2video/voice"

import { buildHtml } from "./assemble.ts"

/**
 * The recorder's browser locale. Native controls (a date field's 10/19/2026)
 * are drawn by the browser, not recorded: drawing them in this machine's
 * locale would show 19/10/2026 where the recording showed 10/19/2026.
 */
const LOCALE = "en-US"

export type VideoOptions = {
  /** Frames per second. */
  fps?: number | undefined
  /** Output height in pixels; the width follows the recording's shape. */
  height?: number | undefined
  /**
   * An exact frame size instead: the recording is scaled to fit inside it
   * and centred, with black bars where its shape differs (letterboxing).
   */
  size?: { width: number; height: number } | undefined
  /** JPEG quality of each captured frame, 1-100. */
  quality?: number | undefined
  /** x264 constant rate factor: lower is better and bigger. */
  crf?: number | undefined
  /** Pages drawing frames at once; default half the cores, at most 6. */
  workers?: number | undefined
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
  // One error listener for the whole encode, not one per frame.
  let broken: Error | null = null
  child.stdin.on("error", (error) => {
    broken = error
  })
  const exited = new Promise<void>((done, fail) => {
    child.on("error", fail)
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    )
  })
  return {
    write: (frame) => {
      if (broken) return Promise.reject(broken)
      return new Promise((done) => {
        if (child.stdin.write(frame)) done()
        else child.stdin.once("drain", done)
      })
    },
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

/** Opens the tour page in render mode and waits until the player is ready. */
async function openTour(page: import("playwright").Page, htmlPath: string): Promise<void> {
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
}

/**
 * Installs the Chromium build the Playwright pr2video runs needs, with that
 * Playwright's own installer (output goes to the terminal).
 */
export async function installChromium(): Promise<number> {
  const require = createRequire(import.meta.url)
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js")
  return await new Promise((done, fail) => {
    // Without npm's variables: under `npx pr2video`, Playwright's installer
    // would take itself for a bare `npx playwright` and only print a warning.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
    )
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", env })
    child.on("error", fail)
    child.on("close", (code) => done(code ?? 1))
  })
}

/** The command that installs the Chromium build matching the Playwright pr2video runs. */
export function chromiumInstall(): string {
  let version = "latest"
  try {
    version = createRequire(import.meta.url)("playwright/package.json").version
  } catch {
    // keep latest
  }
  return `npx -y playwright@${version} install chromium`
}

async function launchChromium() {
  const playwright = await importInstalled<typeof import("playwright")>("playwright", (name) =>
    import.meta.resolve(name),
  )
  // Playwright is a dependency of pr2video, so it is there unless the install is broken.
  if (!playwright)
    throw new Error("Playwright is missing from this install of pr2video; reinstall it")
  try {
    return await playwright.chromium.launch({
      headless: true,
      // Linux and Windows draw date fields in this language; macOS uses the system region.
      args: [`--lang=${LOCALE}`],
      env: { ...process.env, LANG: `${LOCALE.replace("-", "_")}.UTF-8`, LC_ALL: "" },
    })
  } catch (error) {
    throw new Error(
      `cannot start Chromium (${(error as Error).message.split("\n")[0]}); install the build this pr2video uses: pr2video browser install (or ${chromiumInstall()})`,
    )
  }
}

/**
 * The MP4's size: `height` keeps the recording's shape (the width follows);
 * `size` is the exact frame, with the recording fitted inside it and black
 * bars on the sides or top and bottom. Both even, as H.264 needs.
 */
export function videoSize(
  viewport: { width: number; height: number },
  options: Pick<VideoOptions, "height" | "size">,
): {
  scale: number
  picture: { width: number; height: number }
  frame: { width: number; height: number }
} {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  if (options.size) {
    const frame = { width: even(options.size.width), height: even(options.size.height) }
    const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height)
    const picture = {
      width: Math.min(frame.width, even(viewport.width * scale)),
      height: Math.min(frame.height, even(viewport.height * scale)),
    }
    return { scale, picture, frame }
  }
  const scale = (options.height ?? 1080) / viewport.height
  const picture = { width: even(viewport.width * scale), height: even(viewport.height * scale) }
  return { scale, picture, frame: picture }
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
  // The page is the recording's size; the device scale sets the picture's.
  const { scale, picture, frame } = videoSize(viewport, options)
  const { width, height } = frame

  const work = await mkdtemp(join(tmpdir(), "pr2video-render-"))
  const browser = await launchChromium()
  try {
    const htmlPath = join(work, "tour.html")
    await writeFile(htmlPath, html)
    const frames = Math.ceil((timeline.totalMs / 1_000) * fps)
    const workers = Math.max(
      1,
      Math.min(
        options.workers ?? Math.min(6, Math.floor(availableParallelism() / 2)),
        Math.ceil(frames / (fps * 2)),
      ),
    )
    const per = Math.ceil(frames / workers)
    const started = Date.now()
    let done = 0
    const segments = await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        const from = w * per
        const to = Math.min(frames, from + per)
        const segment = join(work, `part-${w}.mp4`)
        // Its own context, so its own renderer process.
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: scale,
          locale: LOCALE,
        })
        const page = await context.newPage()
        await openTour(page, htmlPath)
        const cdp = await context.newCDPSession(page)
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
          picture.width === width && picture.height === height
            ? `scale=${width}:${height}:flags=lanczos`
            : `scale=${picture.width}:${picture.height}:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          String(options.crf ?? 18),
          "-pix_fmt",
          "yuv420p",
          segment,
        ])
        for (let i = from; i < to; i++) {
          await page.evaluate(
            (ms) => (globalThis as unknown as PageGlobals).pr2video?.seek(ms),
            (i * 1_000) / fps,
          )
          // Chromium's own capture: Playwright's screenshot() does more
          // (waits, checks) and took twice as long per frame.
          const shot = (await cdp.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: options.quality ?? 92,
            optimizeForSpeed: true,
          })) as { data: string }
          await encoder.write(Buffer.from(shot.data, "base64"))
          done++
          if (done % (fps * 5) === 0 || done === frames)
            log(`frame ${done}/${frames} (${((Date.now() - started) / 1_000).toFixed(0)}s)`)
        }
        await encoder.finish()
        await context.close()
        return segment
      }),
    )
    const silent = join(work, "video.mp4")
    if (segments.length === 1 && segments[0]) {
      await runFfmpeg(["-y", "-loglevel", "error", "-i", segments[0], "-c", "copy", silent])
    } else {
      const list = join(work, "parts.txt")
      await writeFile(list, segments.map((path) => `file '${path}'\n`).join(""))
      await runFfmpeg([
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        silent,
      ])
    }

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

/**
 * Single frames of the tour as PNGs, drawn exactly as the MP4 would draw them
 * at those tour times: a quick look at a zoom or a mark without rendering the
 * whole video. Writes `<prefix>-<ms>.png` for each time.
 */
export async function renderStills(
  tourPath: string,
  times: ReadonlyArray<number>,
  prefix: string,
  options: { height?: number | undefined } = {},
): Promise<Array<string>> {
  const { html, data } = await buildHtml(tourPath)
  const first = data.tour.scenes[0]
  if (!first) throw new Error("the tour has no scenes")
  const viewport = first.viewport
  const scale = (options.height ?? 720) / viewport.height
  const work = await mkdtemp(join(tmpdir(), "pr2video-stills-"))
  const browser = await launchChromium()
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale, locale: LOCALE })
    const htmlPath = join(work, "tour.html")
    await writeFile(htmlPath, html)
    await openTour(page, htmlPath)
    const written: Array<string> = []
    for (const ms of times) {
      await page.evaluate((t) => (globalThis as unknown as PageGlobals).pr2video?.seek(t), ms)
      const path = resolve(`${prefix}-${Math.round(ms)}.png`)
      await page.screenshot({ path })
      written.push(path)
    }
    return written
  } finally {
    await browser.close()
    await rm(work, { recursive: true, force: true })
  }
}
