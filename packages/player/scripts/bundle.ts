/**
 * Bundles the browser player into one script and one stylesheet
 * (`dist/bundle/`), which every tour page inlines: rrweb, its styles and the
 * player, with no network at play time.
 */
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))
const out = `${root}dist/bundle`

await build({
  entryPoints: [`${root}src/browser/main.ts`],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  conditions: ["pr2video-source"],
  legalComments: "eof",
  outfile: `${out}/player.js`,
  logLevel: "warning",
})

const rrwebCss = createRequire(import.meta.url).resolve("rrweb/dist/style.css")
const css = [
  await readFile(rrwebCss, "utf8"),
  await readFile(`${root}src/browser/player.css`, "utf8"),
]
await writeFile(`${out}/player.css`, css.join("\n"))
console.log(`bundled ${out}`)
