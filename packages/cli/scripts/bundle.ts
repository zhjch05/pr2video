/**
 * Builds the one package that is published: `dist/cli.js` with every
 * workspace package and zod bundled in, plus the files those packages build
 * for run time - the player's script and styles and the recorder's script in
 * `dist/assets/`, the sandbox's image in `image/` (the sandbox finds it at
 * `../image/` from the code, which is now `dist/cli.js`) - the agent skill in
 * `skills/` and the repository's README. Playwright and kokoro-js stay out:
 * they are optional and found where the user installed them.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))
const require = createRequire(import.meta.url)
const fromPackage = (name: string) => require.resolve(name, { paths: [root] })

await rm(`${root}dist`, { recursive: true, force: true })
await rm(`${root}image`, { recursive: true, force: true })
await rm(`${root}skills`, { recursive: true, force: true })

await build({
  entryPoints: [`${root}src/cli.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["pr2video-source"],
  external: ["playwright", "kokoro-js"],
  outfile: `${root}dist/cli.js`,
  legalComments: "eof",
  logLevel: "warning",
})

await mkdir(`${root}dist/assets`, { recursive: true })
await cp(fromPackage("@pr2video/player/bundle.js"), `${root}dist/assets/player.js`)
await cp(fromPackage("@pr2video/player/bundle.css"), `${root}dist/assets/player.css`)
await cp(fromPackage("@pr2video/recorder/record.mjs"), `${root}dist/assets/record.mjs`)
const sandbox = dirname(dirname(fromPackage("@pr2video/sandbox")))
await cp(`${sandbox}/image`, `${root}image`, { recursive: true })
// The agent skill, so `pr2video skill install` gives the skill written for this version.
await cp(`${root}../../skills/pr2video`, `${root}skills/pr2video`, { recursive: true })
// The licences of the third-party code bundled in.
await cp(`${root}../../THIRD_PARTY_NOTICES.md`, `${root}THIRD_PARTY_NOTICES.md`)
// npm shows the package's README; the repository's is the one to show.
await cp(`${root}../../README.md`, `${root}README.md`)
console.log(`bundled ${root}dist/cli.js`)
