#!/usr/bin/env node
/**
 * pr2video: the deterministic half of turning a pull request into a narrated
 * tour. The thinking (which screens, what to say) is the calling agent's; every
 * command here does the same thing every time, reads and writes files, and
 * answers JSON with --json so an agent can act on it.
 */
import { access, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import {
  screenshotMoments,
  type Tour,
  tourProblems,
  tourSchema,
  tourTimeline,
  tourWarnings,
  toVtt,
} from "@pr2video/tour"
import {
  defaultVoice,
  isVoiceId,
  narrateTour,
  speak,
  VOICE_IDS,
  VOICES,
  type VoiceId,
  type VoiceOptions,
} from "@pr2video/voice"

import { buildHtml } from "./assemble.ts"
import { cliVersion, skillDir } from "./assets.ts"
import { importBetterReview } from "./import.ts"
import {
  probeCommand,
  RECORD_HELP,
  type RecordFlags,
  recordCommand,
  SCENES_HELP,
  scenesCheck,
  tourDraft,
} from "./record-commands.ts"
import { SANDBOX_HELP, type SandboxFlags, sandboxCommand } from "./sandbox-commands.ts"
import { installSkill, SKILL_HELP } from "./skill-commands.ts"
import { installChromium, renderStills, renderVideo } from "./video.ts"

const TOUR_HELP = `The tour file:
  pr2video tour draft ...                       Draft it from the recordings (see Recording below)
  pr2video tour check <tour.json> [--json]      Validate a tour file; exit 1 with its problems
  pr2video tour timeline <tour.json> [--vtt <out.vtt>] [--json]
                                                Show the tour's pacing; optionally write captions as WebVTT
  pr2video narrate <tour.json> [voice opts]     Narrate every scene (see pr2video --help for voices)
  pr2video render <tour.json> --frame <ms,...> [--png <prefix>]
                                                Stills, exactly as the video draws them`

const HELP = `pr2video - turn a pull request into a narrated tour

Usage:
  pr2video voices [--json]                      List the free voices and whether each works here
  pr2video speak <text> -o <path> [voice opts]  Speak one line (writes <path>.mp3, or .wav without ffmpeg)
  pr2video narrate <tour.json> [voice opts]     Narrate every scene of a tour and record the clips in it
  pr2video tour check <tour.json> [--json]      Validate a tour file; exit 1 with its problems
  pr2video tour timeline <tour.json> [--vtt <out.vtt>] [--json]
                                                Show the tour's pacing; optionally write captions as WebVTT
  pr2video render <tour.json> [--html <out.html>] [--mp4 <out.mp4>] [--fps 30] [--height 1080 | --size WxH] [--workers n]
                                                The tour as one self-contained HTML file and/or an MP4.
                                                --height keeps the recording's shape (default 1080 tall);
                                                --size 1920x1080 is the exact frame, the recording fitted
                                                inside with black bars where its shape differs
  pr2video render <tour.json> --frame <ms,...> [--png <prefix>]
                                                Single frames as PNGs, exactly as the video draws them
  pr2video import <tour.html> -o <dir>          Import a tour downloaded from better-review
  pr2video browser install                      Install the Chromium build MP4 and stills use (once)
  pr2video --version                            This CLI's version

${SKILL_HELP}

${SANDBOX_HELP}

${RECORD_HELP}

Voice options:
  --voice <id>      ${VOICE_IDS.join(" | ")} | auto (default: auto, the best one available)
  --speaker <name>  The voice's own speaker (say -v name, kokoro voice id, espeak voice)
  --model <path>    Piper's .onnx voice model (or PIPER_MODEL)

Rendering an MP4 or stills needs ffmpeg and Playwright's Chromium (once: pr2video browser install).

Environment:
  PR2VIDEO_CACHE    Where downloaded voice models are cached (default ~/.cache/pr2video)
`

type Flags = SandboxFlags &
  RecordFlags & {
    json?: boolean
    voice?: string
    speaker?: string
    model?: string
    output?: string
    vtt?: string
    html?: string
    mp4?: string
    frame?: string
    png?: string
    fps?: string
    height?: string
    size?: string
    workers?: string
    help?: boolean
    version?: boolean
    force?: boolean
  }

function fail(
  message: string,
  json: boolean | undefined,
  extra: Record<string, unknown> = {},
): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2))
  else console.error(`pr2video: ${message}`)
  process.exit(1)
}

async function chooseVoice(flags: Flags, options: VoiceOptions): Promise<VoiceId> {
  const wanted = flags.voice ?? "auto"
  if (wanted === "auto") return defaultVoice(options)
  if (!isVoiceId(wanted))
    fail(`unknown voice "${wanted}" (choose ${VOICE_IDS.join(", ")} or auto)`, flags.json)
  return wanted
}

async function readTour(path: string, json: boolean | undefined): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`, json)
  }
}

/** Each recording's screenshot moments, so the timeline holds on the right frame; a missing recording is skipped. */
async function shotsFor(tourPath: string, events: ReadonlyArray<string>) {
  const shots = new Map<string, Array<number>>()
  for (const path of new Set(events)) {
    try {
      const parsed = JSON.parse(await readFile(join(dirname(tourPath), path), "utf8"))
      if (Array.isArray(parsed)) shots.set(path, screenshotMoments(parsed))
    } catch {
      // Not recorded yet, or gzipped: the timeline falls back to a settle after the checkpoint.
    }
  }
  return shots
}

/** The files a tour plays that are not there: a recording re-made or moved since the tour was written. */
async function missingFiles(
  tourPath: string,
  tour: Tour,
): Promise<Array<{ path: string; message: string }>> {
  const out: Array<{ path: string; message: string }> = []
  for (const [i, scene] of tour.scenes.entries())
    for (const [key, file] of [
      ["events", scene.events],
      ["audio", scene.audio],
    ] as const) {
      if (!file) continue
      try {
        await access(join(dirname(tourPath), file))
      } catch {
        out.push({
          path: `scenes.${i}.${key}`,
          message: `${file} does not exist (relative to the tour file)`,
        })
      }
    }
  return out
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      voice: { type: "string" },
      speaker: { type: "string" },
      model: { type: "string" },
      output: { type: "string", short: "o" },
      vtt: { type: "string" },
      path: { type: "string" },
      run: { type: "string" },
      side: { type: "string" },
      scenes: { type: "string" },
      only: { type: "string" },
      cwd: { type: "string" },
      record: { type: "boolean" },
      timeout: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      "no-base": { type: "boolean" },
      from: { type: "string" },
      folder: { type: "boolean" },
      all: { type: "boolean" },
      data: { type: "boolean" },
      port: { type: "string" },
      tail: { type: "string" },
      name: { type: "string" },
      html: { type: "string" },
      mp4: { type: "string" },
      frame: { type: "string" },
      png: { type: "string" },
      compare: { type: "boolean" },
      before: { type: "string" },
      fresh: { type: "boolean" },
      fps: { type: "string" },
      workers: { type: "string" },
      height: { type: "string" },
      size: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      force: { type: "boolean" },
      role: { type: "string" },
      find: { type: "string", multiple: true },
    },
  })
  const flags = values as Flags
  const [command, ...rest] = positionals
  const options: VoiceOptions = { speaker: flags.speaker, model: flags.model }

  if (
    flags.help &&
    (command === "sandbox" ||
      command === "record" ||
      command === "scenes" ||
      command === "probe" ||
      command === "tour")
  ) {
    console.log(
      command === "sandbox"
        ? SANDBOX_HELP
        : command === "scenes"
          ? `${RECORD_HELP}\n\n${SCENES_HELP}`
          : command === "tour"
            ? `${TOUR_HELP}\n\n${RECORD_HELP}`
            : RECORD_HELP,
    )
    return
  }
  if (flags.version || command === "version") {
    console.log(await cliVersion())
    return
  }
  if (!command || flags.help || command === "help") {
    console.log(HELP)
    return
  }

  if (command === "voices") {
    const rows = await Promise.all(
      VOICE_IDS.map(async (id) => ({
        id,
        description: VOICES[id].description,
        terms: VOICES[id].terms ?? null,
        ...(await VOICES[id].available(options)),
      })),
    )
    if (flags.json) {
      console.log(JSON.stringify({ voices: rows, auto: await defaultVoice(options) }, null, 2))
      return
    }
    for (const row of rows) {
      const status = row.ok
        ? "ready"
        : `unavailable: ${row.reason}${row.install ? `\n           install: ${row.install}` : ""}`
      console.log(`${row.id.padEnd(8)} ${row.description}\n           ${status}`)
      if (row.terms) console.log(`           note: ${row.terms}`)
    }
    console.log(`\nauto picks: ${await defaultVoice(options)}`)
    return
  }

  if (command === "speak") {
    const text = rest.join(" ").trim()
    if (!text) fail("speak needs the text to say", flags.json)
    if (!flags.output) fail("speak needs -o <path> (written without its extension)", flags.json)
    const voice = await chooseVoice(flags, options)
    if (voice === "none") fail("no voice is available here; run `pr2video voices`", flags.json)
    const clip = await speak(text, voice, flags.output.replace(/\.(mp3|wav)$/, ""), options)
    console.log(
      flags.json
        ? JSON.stringify({ ok: true, voice, ...clip }, null, 2)
        : `${clip.path} (${voice}, ${(clip.durationMs / 1000).toFixed(1)}s)`,
    )
    if (!flags.json && VOICES[voice].terms) console.error(`note: ${VOICES[voice].terms}`)
    return
  }

  if (command === "narrate") {
    const [tourPath] = rest
    if (!tourPath) fail("narrate needs a tour.json", flags.json)
    const problems = tourProblems(await readTour(tourPath, flags.json))
    if (problems.length)
      fail("the tour has problems; run `pr2video tour check`", flags.json, { problems })
    const voice = await chooseVoice(flags, options)
    const log = flags.json ? undefined : (line: string) => console.log(line)
    const result = await narrateTour(tourPath, voice, { ...options, log })
    const terms = VOICES[voice].terms ?? null
    if (flags.json)
      console.log(
        JSON.stringify(
          {
            ok: true,
            voice,
            speaker: result.tour.speaker ?? null,
            spoken: result.spoken,
            reused: result.reused,
            terms,
          },
          null,
          2,
        ),
      )
    else {
      const speaker = result.tour.speaker
      console.log(
        `${voice}${speaker ? ` (${speaker})` : ""}: ${result.spoken} spoken, ${result.reused} reused`,
      )
      if (terms) console.log(`note: ${terms}`)
    }
    return
  }

  if (command === "tour" && rest[0] === "draft") {
    process.exit(await tourDraft(flags))
  }

  if (command === "tour") {
    const [sub, tourPath] = rest
    if (!tourPath || (sub !== "check" && sub !== "timeline"))
      fail("usage: pr2video tour check|timeline <tour.json>", flags.json)
    const input = await readTour(tourPath, flags.json)
    const problems = tourProblems(input)
    if (!problems.length) problems.push(...(await missingFiles(tourPath, tourSchema.parse(input))))
    if (sub === "check") {
      const warnings = problems.length ? [] : tourWarnings(tourSchema.parse(input))
      if (flags.json)
        console.log(JSON.stringify({ ok: problems.length === 0, problems, warnings }, null, 2))
      else if (!problems.length) {
        console.log("tour ok")
        for (const w of warnings) console.log(`warning ${w.path}: ${w.message}`)
      } else for (const p of problems) console.log(`${p.path}: ${p.message}`)
      process.exit(problems.length ? 1 : 0)
    }
    if (problems.length)
      fail("the tour has problems; run `pr2video tour check`", flags.json, { problems })
    const tour = tourSchema.parse(input)
    const timeline = tourTimeline(
      tour.scenes,
      await shotsFor(
        tourPath,
        tour.scenes.map((s) => s.events),
      ),
    )
    if (flags.vtt) await writeFile(flags.vtt, toVtt(timeline))
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            totalMs: timeline.totalMs,
            scenes: timeline.scenes.map((e) => ({
              id: e.scene.id,
              offsetMs: e.offsetMs,
              durationMs: e.durationMs,
              pace: e.pace,
            })),
          },
          null,
          2,
        ),
      )
      return
    }
    const width = Math.max(4, ...timeline.scenes.map((e) => e.scene.label.length))
    for (const e of timeline.scenes)
      console.log(
        `${e.scene.label.padEnd(width)} ${(e.offsetMs / 1000).toFixed(1).padStart(6)}s  +${(e.durationMs / 1000).toFixed(1)}s  ${e.scene.caption}`,
      )
    console.log(
      `total ${(timeline.totalMs / 1000).toFixed(1)}s${flags.vtt ? `, captions in ${flags.vtt}` : ""}`,
    )
    return
  }

  if (command === "scenes") {
    if (rest[0] !== "check") fail("usage: pr2video scenes check [<scenes.json>]", flags.json)
    process.exit(await scenesCheck(rest.slice(1), flags))
  }

  if (command === "record") {
    process.exit(await recordCommand(flags))
  }

  if (command === "probe") {
    process.exit(await probeCommand(rest, flags))
  }

  if (command === "sandbox") {
    process.exit(await sandboxCommand(rest, flags))
  }

  if (command === "render") {
    const [tourPath] = rest
    if (!tourPath || (!flags.html && !flags.mp4 && !flags.frame))
      fail(
        "usage: pr2video render <tour.json> --html <out.html> and/or --mp4 <out.mp4>, or --frame <ms,...> [--png <prefix>]",
        flags.json,
      )
    if (flags.frame) {
      const times = flags.frame.split(",").map((t) => Number(t.trim()))
      if (times.some((t) => !Number.isFinite(t) || t < 0))
        fail(
          "--frame takes tour times in ms, comma-separated (see `pr2video tour timeline`)",
          flags.json,
        )
      const prefix = flags.png ?? join(dirname(tourPath), "frame")
      const written = await renderStills(tourPath, times, prefix, {
        height: flags.height ? Number(flags.height) : undefined,
      })
      if (flags.json) console.log(JSON.stringify({ ok: true, frames: written }, null, 2))
      else for (const path of written) console.log(path)
      if (!flags.html && !flags.mp4) return
    }
    const outputs: Record<string, unknown> = {}
    if (flags.html) {
      const { html } = await buildHtml(tourPath)
      await writeFile(flags.html, html)
      outputs.html = { path: flags.html, bytes: Buffer.byteLength(html) }
      if (!flags.json)
        console.log(`${flags.html} (${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB)`)
    }
    if (flags.mp4) {
      const number = (value: string | undefined, name: string) => {
        if (value === undefined) return undefined
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`, flags.json)
        return n
      }
      let size: { width: number; height: number } | undefined
      if (flags.size) {
        const match = /^(\d+)x(\d+)$/i.exec(flags.size.trim())
        if (!match) fail("--size is <width>x<height>, e.g. 1920x1080", flags.json)
        if (flags.height) fail("give --size or --height, not both", flags.json)
        size = { width: Number(match[1]), height: Number(match[2]) }
        if (size.width < 16 || size.height < 16 || size.width > 7680 || size.height > 4320)
          fail("--size must be between 16x16 and 7680x4320", flags.json)
      }
      const video = await renderVideo(tourPath, flags.mp4, {
        fps: number(flags.fps, "fps"),
        workers: number(flags.workers, "workers"),
        height: number(flags.height, "height"),
        size,
        log: flags.json ? undefined : (line) => console.log(line),
      })
      outputs.mp4 = video
      if (!flags.json)
        console.log(
          `${video.path} (${video.width}x${video.height}, ${(video.durationMs / 1000).toFixed(1)}s, ${video.frames} frames)`,
        )
    }
    if (flags.json) console.log(JSON.stringify({ ok: true, ...outputs }, null, 2))
    return
  }

  if (command === "browser" && rest[0] === "install") process.exit(await installChromium())
  if (command === "skill") {
    if (rest[0] === "install" && rest[1]) {
      try {
        console.log(await installSkill(rest[1], { force: flags.force }))
      } catch (error) {
        fail((error as Error).message, flags.json)
      }
      return
    }
    if (rest[0] === "path") {
      console.log(await skillDir())
      return
    }
    fail(
      "usage: pr2video skill install <skills folder> [--force] | pr2video skill path",
      flags.json,
    )
  }
  if (command === "import") {
    const [htmlPath] = rest
    if (!htmlPath || !flags.output) fail("usage: pr2video import <tour.html> -o <dir>", flags.json)
    const tour = await importBetterReview(htmlPath, flags.output)
    const result = { ok: true, tour: join(flags.output, "tour.json"), scenes: tour.scenes.length }
    console.log(
      flags.json ? JSON.stringify(result, null, 2) : `${result.tour} (${result.scenes} scenes)`,
    )
    return
  }

  fail(`unknown command "${command}"; run pr2video --help`, flags.json)
}

main().catch((error: unknown) => {
  console.error(`pr2video: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
