/**
 * Files the CLI reads at run time that other workspace packages build: the
 * player's script and styles and the recorder's in-sandbox script. The
 * published `pr2video` carries copies in `dist/assets/` beside `cli.js`; in
 * this workspace (`pnpm pr2video`, tests) they come from the packages.
 */
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ASSETS = {
  "player.js": "@pr2video/player/bundle.js",
  "player.css": "@pr2video/player/bundle.css",
  "record.mjs": "@pr2video/recorder/record.mjs",
} as const

export type Asset = keyof typeof ASSETS

export async function assetPath(name: Asset): Promise<string> {
  const bundled = fileURLToPath(new URL(`./assets/${name}`, import.meta.url))
  try {
    await access(bundled)
    return bundled
  } catch {
    return fileURLToPath(import.meta.resolve(ASSETS[name]))
  }
}
