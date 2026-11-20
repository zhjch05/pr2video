/**
 * Puts a tour together for the player: the tour file, every recording it
 * plays (gzipped, base64), its narration (data URLs), and when each
 * recording's screenshots were taken - then the page around it.
 */
import { readFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { gzipSync } from "node:zlib"

import { type PlayerData, tourHtml } from "@pr2video/player"
import { secretsAbove, secretsInJson } from "@pr2video/sandbox"
import { screenshotMoments, tourProblems, tourSchema } from "@pr2video/tour"

import { type Asset, assetPath } from "./assets.ts"

/** A font the recorder inlined (or the app served inline): \`data:font/woff2;base64,...\`. */
const FONT_DATA_URL =
  /data:(?:font\/[\w.+-]+|application\/(?:x-)?font-[\w.+-]+|application\/vnd\.ms-fontobject);base64,[A-Za-z0-9+/=]+/g

const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
}

/** Reads a recording, plain or gzipped JSON, as its events. */
async function readEvents(
  path: string,
): Promise<{ json: string; events: Array<{ timestamp: number }> }> {
  const bytes = await readFile(path)
  const text =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? (await import("node:zlib")).gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8")
  const events = JSON.parse(text) as Array<{ timestamp: number }>
  if (!Array.isArray(events) || !events.length) throw new Error(`${path} holds no rrweb events`)
  return { json: text, events }
}

export async function playerData(tourPath: string): Promise<PlayerData> {
  const tourText = await readFile(tourPath, "utf8")
  const input = JSON.parse(tourText) as unknown
  const problems = tourProblems(input)
  if (problems.length)
    throw new Error(
      `the tour has problems: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`,
    )
  const tour = tourSchema.parse(input)
  const root = dirname(tourPath)
  // A tour is made to be shared: never with a project secret's value in it.
  const secrets = await secretsAbove(tourPath)
  const refuse = (what: string, json: string, fix: string) => {
    const names = secretsInJson(json, secrets)
    if (names.length)
      throw new Error(`${what} holds the value of ${names.join(", ")} (a project secret): ${fix}`)
  }
  refuse(tourPath, tourText, "take it out of the title, summary and captions")
  const events: PlayerData["events"] = {}
  const shots: PlayerData["shots"] = {}
  const audio: PlayerData["audio"] = {}
  const fonts: Array<string> = []
  const fontIndex = new Map<string, number>()
  // Each font once for the whole tour; a recording keeps a reference to it.
  const shareFonts = (json: string) =>
    json.replace(FONT_DATA_URL, (url) => {
      let n = fontIndex.get(url)
      if (n === undefined) {
        n = fonts.push(url) - 1
        fontIndex.set(url, n)
      }
      return `p2v-font:${n}`
    })
  for (const scene of tour.scenes) {
    if (!(scene.events in events)) {
      const recording = await readEvents(join(root, scene.events))
      refuse(
        scene.events,
        recording.json,
        "record that scene again (`pr2video record` replaces a value it sees with ***), or take it out of the tour",
      )
      events[scene.events] = gzipSync(shareFonts(recording.json)).toString("base64")
      shots[scene.events] = screenshotMoments(recording.events)
    }
    if (scene.audio && !(scene.audio in audio)) {
      const type = AUDIO_TYPES[extname(scene.audio).toLowerCase()] ?? "audio/mpeg"
      audio[scene.audio] =
        `data:${type};base64,${(await readFile(join(root, scene.audio))).toString("base64")}`
    }
  }
  return { tour, events, audio, shots, ...(fonts.length ? { fonts } : {}) }
}

/** The player's bundled script and styles, built by `@pr2video/player`. */
export async function playerBundle(): Promise<{ js: string; css: string }> {
  const read = async (name: Asset) => {
    const path = await assetPath(name)
    try {
      return await readFile(path, "utf8")
    } catch {
      throw new Error(`the player bundle is missing (${path}); run \`pnpm build\` first`)
    }
  }
  return { js: await read("player.js"), css: await read("player.css") }
}

export async function buildHtml(tourPath: string): Promise<{ html: string; data: PlayerData }> {
  const data = await playerData(tourPath)
  return { html: tourHtml(data, await playerBundle()), data }
}
