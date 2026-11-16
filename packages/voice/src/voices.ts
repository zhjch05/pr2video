/**
 * The free voices: every one runs on this machine and needs no key or account.
 *
 * - `kokoro`: Kokoro-82M, a small neural model (Apache-2.0) run in Node with
 *   ONNX. The most natural of the free voices. Its model (~90 MB) downloads
 *   from Hugging Face on first use and is cached.
 * - `say`: macOS's built-in speech. Nothing to install; macOS only.
 * - `piper`: the Piper engine, if installed, with a voice model you name.
 * - `espeak`: eSpeak NG, if installed. Robotic, but everywhere and tiny.
 * - `none`: captions only; scenes hold for reading time instead.
 *
 * Each voice writes WAV; `speak` measures and (with ffmpeg) compresses it.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { importInstalled, resolveInstalled } from "./installed.ts"
import { onPath, runOrThrow } from "./run.ts"
import { encodeWav } from "./wav.ts"

export type Availability = { ok: true } | { ok: false; reason: string; install?: string }

export type VoiceOptions = {
  /** The voice's own speaker name: a `say -v` voice, a kokoro voice id, an espeak voice. */
  speaker?: string | undefined
  /** Piper's `.onnx` voice model. */
  model?: string | undefined
}

export interface Voice {
  readonly id: VoiceId
  readonly description: string
  available(options?: VoiceOptions): Promise<Availability>
  /** The caption spoken, as WAV bytes. */
  synthesize(text: string, options?: VoiceOptions): Promise<Uint8Array>
}

export const VOICE_IDS = ["kokoro", "say", "piper", "espeak", "none"] as const
export type VoiceId = (typeof VOICE_IDS)[number]

/** Where downloaded models are cached: `$PR2VIDEO_CACHE`, else `~/.cache/pr2video`. */
export function cacheDir(): string {
  return process.env.PR2VIDEO_CACHE || join(homedir(), ".cache", "pr2video")
}

/** Runs `write(path)` against a fresh temp WAV path and returns the file's bytes. */
async function viaTempWav(write: (path: string) => Promise<void>): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "pr2video-voice-"))
  try {
    const path = join(dir, "out.wav")
    await write(path)
    return new Uint8Array(await readFile(path))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const say: Voice = {
  id: "say",
  description: "macOS built-in speech (no install, macOS only)",
  async available() {
    if (process.platform !== "darwin") return { ok: false, reason: "`say` exists only on macOS" }
    return (await onPath("say")) ? { ok: true } : { ok: false, reason: "`say` is not on PATH" }
  },
  synthesize(text, options) {
    return viaTempWav(async (path) => {
      const args = ["-o", path, "--file-format=WAVE", "--data-format=LEI16@24000", "-f", "-"]
      if (options?.speaker) args.unshift("-v", options.speaker)
      await runOrThrow("say", args, text)
    })
  },
}

const espeak: Voice = {
  id: "espeak",
  description: "eSpeak NG (tiny, robotic, any OS)",
  async available() {
    if (await onPath("espeak-ng")) return { ok: true }
    return {
      ok: false,
      reason: "espeak-ng is not installed",
      install: "brew install espeak-ng  |  apt install espeak-ng",
    }
  },
  synthesize(text, options) {
    return viaTempWav(async (path) => {
      await runOrThrow(
        "espeak-ng",
        ["-v", options?.speaker ?? "en-us", "-s", "165", "-w", path, "--stdin"],
        text,
      )
    })
  },
}

const PIPER_INSTALL =
  "pipx install piper-tts, then download a voice (.onnx + .onnx.json) from https://huggingface.co/rhasspy/piper-voices and pass --model or set PIPER_MODEL"

function piperModel(options?: VoiceOptions): string | undefined {
  return options?.model ?? process.env.PIPER_MODEL
}

const piper: Voice = {
  id: "piper",
  description: "Piper neural TTS (needs piper and a voice model)",
  async available(options) {
    if (!(await onPath("piper")))
      return { ok: false, reason: "piper is not installed", install: PIPER_INSTALL }
    if (!piperModel(options))
      return { ok: false, reason: "no Piper voice model given", install: PIPER_INSTALL }
    return { ok: true }
  },
  synthesize(text, options) {
    const model = piperModel(options)
    if (!model) throw new Error("piper needs a voice model: --model <voice.onnx> or PIPER_MODEL")
    return viaTempWav(async (path) => {
      await runOrThrow("piper", ["--model", model, "--output_file", path], text)
    })
  },
}

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX"
export const KOKORO_DEFAULT_SPEAKER = "af_heart"

type KokoroAudio = { audio: Float32Array; sampling_rate: number }
type KokoroTTS = { generate(text: string, options: { voice: string }): Promise<KokoroAudio> }
type KokoroModule = {
  KokoroTTS: {
    from_pretrained(id: string, options: { dtype: string; device: string }): Promise<KokoroTTS>
  }
}

let kokoroModel: Promise<KokoroTTS> | null = null

/**
 * kokoro-js is an optional dependency: it pulls in transformers.js and the
 * ONNX runtime (~100 MB), which a captions-only user should not pay for.
 */
async function importKokoro(): Promise<KokoroModule | null> {
  return importInstalled<KokoroModule>("kokoro-js")
}

/**
 * transformers.js caches models inside its own `node_modules` folder by
 * default, so a reinstall downloads them again. Point it at `cacheDir()`. It
 * is kokoro-js's dependency, not ours, so resolve it from kokoro-js - and the
 * ESM build, the very module instance kokoro-js imports.
 */
async function moveModelCache(): Promise<void> {
  try {
    const kokoro = resolveInstalled("kokoro-js")
    if (!kokoro) return
    const kokoroFile = fileURLToPath(kokoro)
    const cjs = createRequire(kokoroFile).resolve("@huggingface/transformers")
    const esm = pathToFileURL(cjs.replace(/\.cjs$/, ".mjs")).href
    const transformers = (await import(esm)) as { env?: { cacheDir?: string } }
    if (transformers.env) transformers.env.cacheDir = join(cacheDir(), "models")
  } catch {
    // A layout we do not know: transformers.js keeps its default cache.
  }
}

async function loadKokoro(): Promise<KokoroTTS> {
  kokoroModel ??= (async () => {
    const kokoro = await importKokoro()
    if (!kokoro) throw new Error("kokoro-js is not installed: npm install -g kokoro-js")
    await moveModelCache()
    return kokoro.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" })
  })()
  try {
    return await kokoroModel
  } catch (error) {
    kokoroModel = null
    throw error
  }
}

const kokoro: Voice = {
  id: "kokoro",
  description: "Kokoro-82M neural voice, local (most natural; ~90 MB model on first use)",
  async available() {
    if (await importKokoro()) return { ok: true }
    return { ok: false, reason: "kokoro-js is not installed", install: "npm install -g kokoro-js" }
  },
  async synthesize(text, options) {
    const tts = await loadKokoro()
    const out = await tts.generate(text, { voice: options?.speaker ?? KOKORO_DEFAULT_SPEAKER })
    return encodeWav(out.audio, out.sampling_rate)
  },
}

const none: Voice = {
  id: "none",
  description: "No narration: captions only, held for reading time",
  async available() {
    return { ok: true }
  },
  async synthesize() {
    throw new Error("the `none` voice speaks nothing")
  },
}

export const VOICES: Record<VoiceId, Voice> = { kokoro, say, piper, espeak, none }

export function isVoiceId(value: string): value is VoiceId {
  return (VOICE_IDS as ReadonlyArray<string>).includes(value)
}

/** The first voice that works here, in order of quality: kokoro, say, piper, espeak, else none. */
export async function defaultVoice(options?: VoiceOptions): Promise<VoiceId> {
  for (const id of VOICE_IDS) if ((await VOICES[id].available(options)).ok) return id
  return "none"
}
