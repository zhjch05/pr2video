/**
 * What a self-contained tour page carries: the tour and everything it plays,
 * inline, so the file opens from disk with no network. Recordings are gzipped
 * JSON as base64; narration is a data URL.
 */
import type { Tour } from "@pr2video/tour"

export type PlayerData = {
  tour: Tour
  /** By the scene's `events` path: the rrweb events, gzipped JSON, base64. */
  events: Record<string, string>
  /** By the scene's `audio` path: a `data:audio/...;base64,` URL. */
  audio: Record<string, string>
  /** By `events` path: when the recorder took its screenshots (`screenshotMoments`), worked out once when the page is built. */
  shots: Record<string, Array<number>>
  /**
   * Fonts the recordings share, each once: a recording holds \`p2v-font:<n>\`
   * where its events had the font's data URL (an app with many web fonts
   * otherwise carried all of them once per recording).
   */
  fonts?: Array<string> | undefined
}

/** The element the data sits in, and the one the player mounts on. */
export const DATA_ID = "pr2video-data"
export const ROOT_ID = "pr2video-root"

/** Puts `data` in a `<script>` safely: `<` is escaped, so nothing in it can close the tag. */
export function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  )
}

/** The whole tour as one HTML document: the player's script and styles, and its data, inline. */
export function tourHtml(data: PlayerData, bundle: { js: string; css: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="pr2video">
<title>${escapeHtml(data.tour.title)}</title>
<style>${bundle.css}</style>
</head>
<body>
<div id="${ROOT_ID}"></div>
<script type="application/json" id="${DATA_ID}">${embedJson(data)}</script>
<script>${bundle.js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`
}
