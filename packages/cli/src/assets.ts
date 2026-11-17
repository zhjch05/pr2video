/**
 * Files the CLI reads at run time that other workspace packages build: the
 * player's script and styles and the recorder's in-sandbox script. The
 * published `pr2video` carries copies in `dist/assets/` beside `cli.js`; in
 * this workspace (`pnpm pr2video`, tests) they come from the packages.
 */
import { access, readFile } from "node:fs/promises"
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

/**
 * The agent skill (SKILL.md and its references). The published package carries
 * a copy in `skills/pr2video/`, so the skill always matches the CLI beside it;
 * in this workspace it is the repository's `skills/pr2video/`.
 */
export async function skillDir(): Promise<string> {
  for (const relative of ["../skills/pr2video/", "../../../skills/pr2video/"]) {
    const dir = fileURLToPath(new URL(relative, import.meta.url))
    try {
      await access(`${dir}SKILL.md`)
      return dir
    } catch {}
  }
  throw new Error("the pr2video skill is missing from this install")
}

/** This CLI's version, from its package.json (one level up from both `src/` and `dist/`). */
export async function cliVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  return String(manifest.version)
}
