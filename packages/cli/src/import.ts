/**
 * Imports a tour downloaded from better-review (its "Download" on the Tour
 * tab: one HTML file with the tour, gzipped recordings and MP3 narration
 * inline) as a pr2video tour directory: `tour.json`, `recordings/`, `audio/`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import { type Tour, type TourScene, tourSchema } from "@pr2video/tour"

import { run } from "./process.ts"

type ExportTarget = {
  box: { x: number; y: number; width: number; height: number }
  node?: number | null
}
type ExportScene = {
  id: string
  story: string
  eventsArtifactId: string
  viewport: { width: number; height: number }
  startMs: number
  endMs: number
  atMs: number
  shotMs?: number | null
  caption: string
  focus: ExportTarget | null
  zoom: 1 | 1.5 | 2
  markers: Array<
    ExportTarget & { label: string | null; tone: "added" | "removed" | "changed" | "note" }
  >
  audioArtifactId: string | null
}
type ExportData = {
  title: string
  summary: string
  scenes: Array<ExportScene>
  events: Record<string, string>
  audio: Record<string, string>
}

/** A clip's length from ffprobe; null when ffprobe is not installed (the scene then holds for reading time). */
async function durationMs(path: string): Promise<number | null> {
  try {
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

const target = (t: ExportTarget) => ({ box: t.box, node: t.node ?? null })

export async function importBetterReview(htmlPath: string, outDir: string): Promise<Tour> {
  const html = await readFile(htmlPath, "utf8")
  const match = html.match(/<script[^>]*id="tour-data"[^>]*>([\s\S]*?)<\/script>/)
  if (!match?.[1]) throw new Error(`${htmlPath} is not a downloaded better-review tour`)
  const data = JSON.parse(match[1]) as ExportData
  await mkdir(join(outDir, "recordings"), { recursive: true })
  await mkdir(join(outDir, "audio"), { recursive: true })
  for (const [id, encoded] of Object.entries(data.events))
    await writeFile(
      join(outDir, "recordings", `${id}.json`),
      gunzipSync(Buffer.from(encoded, "base64")),
    )
  const scenes: Array<TourScene> = []
  for (const scene of data.scenes) {
    let audio: string | null = null
    let audioMs: number | null = null
    const clip = scene.audioArtifactId ? data.audio[scene.audioArtifactId] : undefined
    if (scene.audioArtifactId && clip) {
      audio = `audio/${scene.audioArtifactId}.mp3`
      await writeFile(join(outDir, audio), Buffer.from(clip, "base64"))
      audioMs = await durationMs(join(outDir, audio))
    }
    scenes.push({
      id: scene.id,
      label: scene.story,
      events: `recordings/${scene.eventsArtifactId}.json`,
      viewport: scene.viewport,
      startMs: scene.startMs,
      endMs: scene.endMs,
      atMs: scene.atMs,
      shotMs: scene.shotMs ?? null,
      caption: scene.caption,
      focus: scene.focus ? target(scene.focus) : null,
      zoom: scene.zoom,
      markers: scene.markers.map((m) => ({ ...target(m), label: m.label, tone: m.tone })),
      audio,
      audioMs,
    })
  }
  const tour = tourSchema.parse({
    version: 1,
    title: data.title,
    summary: data.summary,
    scenes,
    voice: scenes.some((s) => s.audio) ? "imported" : "none",
  })
  await writeFile(join(outDir, "tour.json"), `${JSON.stringify(tour, null, 2)}\n`)
  return tour
}
