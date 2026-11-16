/**
 * The player's entry in a tour page: reads the page's data and mounts the
 * player. `?render` mounts it for a renderer instead: no controls, the stage
 * filling the window, and `window.pr2video` to step through frames.
 */
import { DATA_ID, type PlayerData, ROOT_ID } from "../data.ts"
import { TourPlayer } from "./player.ts"

export type RenderApi = {
  totalMs: number
  /** Draws the frame at tour time `ms`; resolves once it is painted. */
  seek(ms: number): Promise<void>
}

declare global {
  interface Window {
    pr2video?: RenderApi
    pr2videoError?: string
  }
}

function main() {
  const root = document.getElementById(ROOT_ID)
  const script = document.getElementById(DATA_ID)
  if (!root || !script?.textContent) throw new Error("this page has no tour")
  const data = JSON.parse(script.textContent) as PlayerData
  const render = new URLSearchParams(location.search).has("render")
  document.documentElement.classList.toggle("p2v-render-page", render)
  const player = new TourPlayer(root, data, render ? "render" : "interactive")
  if (render) window.pr2video = { totalMs: player.timeline.totalMs, seek: (ms) => player.seek(ms) }
  else player.start()
}

try {
  main()
} catch (error) {
  window.pr2videoError = error instanceof Error ? error.message : String(error)
  document.body.textContent = `Could not open the tour: ${window.pr2videoError}`
}
