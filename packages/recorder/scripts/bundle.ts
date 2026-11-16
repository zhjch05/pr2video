/**
 * Bundles the recorder into one file (`dist/record.mjs`) that runs inside the
 * sandbox under plain node. Playwright and rrweb stay external: the sandbox
 * image has them in /opt/pr2video, where the script is copied.
 */
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))
await build({
  entryPoints: [`${root}src/record.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["playwright", "rrweb"],
  outfile: `${root}dist/record.mjs`,
  logLevel: "warning",
})
console.log(`bundled ${root}dist/record.mjs`)
