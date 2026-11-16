/**
 * Narrating a tour: each scene's caption spoken by one voice, written next to
 * the tour file, and the tour updated with where each clip is and how long it
 * runs - the timeline holds each scene until its narration ends.
 */
import { createHash } from "node:crypto"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { type Tour, tourSchema } from "@pr2video/tour"

import { onPath, runOrThrow } from "./run.ts"
import { VOICES, type VoiceId, type VoiceOptions } from "./voices.ts"
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
  const scenes = []
  for (const scene of tour.scenes) {
    if (voice === "none") {
      scenes.push({ ...scene, audio: null, audioMs: null })
      continue
    }
    const base = join(root, "audio", `${scene.id}-${clipKey(voice, scene.caption, options)}`)
    const known =
      scene.audio &&
      scene.audioMs != null &&
      relative(root, base) === scene.audio.replace(/\.(mp3|wav)$/, "")
    if (known && scene.audio && (await exists(join(root, scene.audio)))) {
      scenes.push(scene)
      reused++
      continue
    }
    const clip = await speak(scene.caption, voice, base, options)
    options.log?.(
      `${scene.label}: ${(clip.durationMs / 1000).toFixed(1)}s ${relative(root, clip.path)}`,
    )
    scenes.push({ ...scene, audio: relative(root, clip.path), audioMs: clip.durationMs })
    spoken++
  }
  const next: Tour = { ...tour, scenes, voice }
  await writeFile(tourPath, `${JSON.stringify(next, null, 2)}\n`)
  return { tour: next, spoken, reused }
}
