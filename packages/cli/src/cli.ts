#!/usr/bin/env node
/**
 * pr2video: the deterministic half of turning a pull request into a narrated
 * tour. The thinking (which screens, what to say) is the calling agent's; every
 * command here does the same thing every time, reads and writes files, and
 * answers JSON with --json so an agent can act on it.
 */
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { screenshotMoments, tourProblems, tourSchema, tourTimeline, toVtt } from "@pr2video/tour"
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

const HELP = `pr2video - turn a pull request into a narrated tour

Usage:
  pr2video voices [--json]                      List the free voices and whether each works here
  pr2video speak <text> -o <path> [voice opts]  Speak one line (writes <path>.mp3, or .wav without ffmpeg)
  pr2video narrate <tour.json> [voice opts]     Narrate every scene of a tour and record the clips in it
  pr2video tour check <tour.json> [--json]      Validate a tour file; exit 1 with its problems
  pr2video tour timeline <tour.json> [--vtt <out.vtt>] [--json]
                                                Show the tour's pacing; optionally write captions as WebVTT

Voice options:
  --voice <id>      ${VOICE_IDS.join(" | ")} | auto (default: auto, the best one available)
  --speaker <name>  The voice's own speaker (say -v name, kokoro voice id, espeak voice)
  --model <path>    Piper's .onnx voice model (or PIPER_MODEL)

Environment:
  PR2VIDEO_CACHE    Where downloaded voice models are cached (default ~/.cache/pr2video)
`

type Flags = {
  json?: boolean
  voice?: string
  speaker?: string
  model?: string
  output?: string
  vtt?: string
  help?: boolean
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
      help: { type: "boolean", short: "h" },
    },
  })
  const flags = values as Flags
  const [command, ...rest] = positionals
  const options: VoiceOptions = { speaker: flags.speaker, model: flags.model }

  if (!command || flags.help || command === "help") {
    console.log(HELP)
    return
  }

  if (command === "voices") {
    const rows = await Promise.all(
      VOICE_IDS.map(async (id) => ({
        id,
        description: VOICES[id].description,
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
    if (flags.json)
      console.log(
        JSON.stringify({ ok: true, voice, spoken: result.spoken, reused: result.reused }, null, 2),
      )
    else console.log(`${voice}: ${result.spoken} spoken, ${result.reused} reused`)
    return
  }

  if (command === "tour") {
    const [sub, tourPath] = rest
    if (!tourPath || (sub !== "check" && sub !== "timeline"))
      fail("usage: pr2video tour check|timeline <tour.json>", flags.json)
    const input = await readTour(tourPath, flags.json)
    const problems = tourProblems(input)
    if (sub === "check") {
      if (flags.json) console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
      else if (!problems.length) console.log("tour ok")
      else for (const p of problems) console.log(`${p.path}: ${p.message}`)
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
    for (const e of timeline.scenes)
      console.log(
        `${e.scene.label.padEnd(4)} ${(e.offsetMs / 1000).toFixed(1).padStart(6)}s  +${(e.durationMs / 1000).toFixed(1)}s  ${e.scene.caption}`,
      )
    console.log(
      `total ${(timeline.totalMs / 1000).toFixed(1)}s${flags.vtt ? `, captions in ${flags.vtt}` : ""}`,
    )
    return
  }

  fail(`unknown command "${command}"; run pr2video --help`, flags.json)
}

main().catch((error: unknown) => {
  console.error(`pr2video: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
