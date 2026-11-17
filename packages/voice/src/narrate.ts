/**
 * Narrating a tour: each scene's caption spoken by one voice, written next to
 * the tour file, and the tour updated with where each clip is and how long it
 * runs - the timeline holds each scene until its narration ends.
 */
import { createHash } from "node:crypto"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { type Tour, tourSchema } from "@pr2video/tour"

import { onPath, run, runOrThrow } from "./run.ts"
import { speakerOf, VOICES, type VoiceId, type VoiceOptions } from "./voices.ts"
import { wavDurationMs } from "./wav.ts"

export type Spoken = { path: string; durationMs: number; format: "mp3" | "wav" }

/**
 * Speaks `text` into `pathWithoutExtension` + ".mp3" when ffmpeg is on PATH
 * (a tenth of the bytes, what the HTML tour inlines), else ".wav".
 */
export async function speak(
  text: string,
  voice: VoiceId,
  pathWithoutExtension: string,
  options: VoiceOptions & { mp3?: boolean } = {},
): Promise<Spoken> {
  const available = await VOICES[voice].available(options)
  if (!available.ok)
    throw new Error(
      `voice "${voice}" is unavailable: ${available.reason}${available.install ? ` (${available.install})` : ""}`,
    )
  const wav = await VOICES[voice].synthesize(text, options)
  const durationMs = wavDurationMs(wav)
  await mkdir(dirname(pathWithoutExtension), { recursive: true })
  const wavPath = `${pathWithoutExtension}.wav`
  await writeFile(wavPath, wav)
  if (options.mp3 === false || !(await onPath("ffmpeg")))
    return { path: wavPath, durationMs, format: "wav" }
  const mp3Path = `${pathWithoutExtension}.mp3`
  await runOrThrow("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    wavPath,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "4",
    mp3Path,
  ])
  await rm(wavPath, { force: true })
  return { path: mp3Path, durationMs, format: "mp3" }
}

/** Names a clip by everything that shapes its sound, so an unchanged caption is never spoken twice. */
export function clipKey(voice: VoiceId, text: string, options: VoiceOptions = {}): string {
  return createHash("sha256")
    .update(JSON.stringify([voice, options.speaker ?? null, options.model ?? null, text]))
    .digest("hex")
    .slice(0, 12)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** A clip's length: read from a WAV, or asked of ffprobe for anything else; null when unknown. */
async function clipLength(path: string): Promise<number | null> {
  try {
    if (path.endsWith(".wav")) return wavDurationMs(new Uint8Array(await readFile(path)))
    const result = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      path,
    ])
    const seconds = Number.parseFloat(result.stdout)
    return result.code === 0 && Number.isFinite(seconds) ? Math.round(seconds * 1_000) : null
  } catch {
    return null
  }
}

export type NarrateResult = { tour: Tour; spoken: number; reused: number }

/**
 * Narrates every scene of the tour at `tourPath` with `voice` and writes the
 * tour back. Clips land in `audio/` beside the tour. `none` removes narration.
 */
export async function narrateTour(
  tourPath: string,
  voice: VoiceId,
  options: VoiceOptions & { log?: ((line: string) => void) | undefined } = {},
): Promise<NarrateResult> {
  const tour = tourSchema.parse(JSON.parse(await readFile(tourPath, "utf8")))
  const root = dirname(tourPath)
  let spoken = 0
  let reused = 0
  // Clips are named by what they say, not by scene: the same caption is
  // spoken once, whatever its scene is called now.
  const known = new Map<string, number>()
  for (const scene of tour.scenes)
    if (scene.audio && scene.audioMs != null) known.set(scene.audio, scene.audioMs)
  const scenes = []
  for (const scene of tour.scenes) {
    if (voice === "none") {
      scenes.push({ ...scene, audio: null, audioMs: null })
      continue
    }
    const key = clipKey(voice, scene.caption, options)
    let reuse: { audio: string; audioMs: number } | null = null
    for (const extension of ["mp3", "wav"]) {
      const audio = `audio/${key}.${extension}`
      const audioMs = known.get(audio) ?? (await clipLength(join(root, audio)))
      if (audioMs != null && (await exists(join(root, audio)))) {
        reuse = { audio, audioMs }
        break
      }
    }
    if (reuse) {
      scenes.push({ ...scene, ...reuse })
      known.set(reuse.audio, reuse.audioMs)
      reused++
      continue
    }
    const clip = await speak(scene.caption, voice, join(root, "audio", key), options)
    const audio = relative(root, clip.path)
    options.log?.(`${scene.label}: ${(clip.durationMs / 1000).toFixed(1)}s ${audio}`)
    scenes.push({ ...scene, audio, audioMs: clip.durationMs })
    known.set(audio, clip.durationMs)
    spoken++
  }
  const next: Tour = { ...tour, scenes, voice, speaker: speakerOf(voice, options) }
  await writeFile(tourPath, `${JSON.stringify(next, null, 2)}\n`)
  return { tour: next, spoken, reused }
}
