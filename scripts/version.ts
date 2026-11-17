/**
 * The version lives in four places that must agree: the CLI's package.json,
 * the Claude Code plugin manifest, and the skill (its metadata and the
 * version it tells agents to run). `node scripts/version.ts <version>` sets
 * all of them; `node scripts/version.ts --check [<version>]` fails when they
 * disagree, or differ from the version given (the release tag).
 */
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = new URL("..", import.meta.url)
const CLI = new URL("packages/cli/package.json", root)
const PLUGIN = new URL(".claude-plugin/plugin.json", root)
const SKILL = new URL("skills/pr2video/SKILL.md", root)

const SKILL_VERSIONS = [
  /(\n {2}version: ")([^"]+)(")/,
  /(written for pr2video )(\S+?)([.:]\s)/,
  /(npx -y pr2video@)([^`\s]+)(`)/,
]

async function json(url: URL) {
  return JSON.parse(await readFile(url, "utf8"))
}

async function versions(): Promise<Record<string, string>> {
  const skill = await readFile(SKILL, "utf8")
  const found: Record<string, string> = {
    "packages/cli/package.json": (await json(CLI)).version,
    ".claude-plugin/plugin.json": (await json(PLUGIN)).version,
  }
  SKILL_VERSIONS.forEach((pattern, i) => {
    found[`skills/pr2video/SKILL.md (${i + 1})`] = skill.match(pattern)?.[2] ?? "(missing)"
  })
  return found
}

async function set(version: string) {
  for (const url of [CLI, PLUGIN]) {
    const manifest = await json(url)
    manifest.version = version
    await writeFile(url, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  let skill = await readFile(SKILL, "utf8")
  for (const pattern of SKILL_VERSIONS) skill = skill.replace(pattern, `$1${version}$3`)
  await writeFile(SKILL, skill)
  // Keep the manifests the way the linter formats them.
  execFileSync(
    "pnpm",
    ["exec", "biome", "format", "--write", fileURLToPath(CLI), fileURLToPath(PLUGIN)],
    {
      stdio: "ignore",
    },
  )
}

const [first, second] = process.argv.slice(2)
if (first === "--check") {
  const found = await versions()
  const wanted = second ?? found["packages/cli/package.json"]
  const wrong = Object.entries(found).filter(([, v]) => v !== wanted)
  if (wrong.length) {
    for (const [where, v] of Object.entries(found)) console.error(`${v.padEnd(12)} ${where}`)
    console.error(`every version must be ${wanted}: node scripts/version.ts ${wanted}`)
    process.exit(1)
  }
  console.log(`version ${wanted} everywhere`)
} else if (first && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(first)) {
  await set(first)
  console.log(`set version ${first}; check with node scripts/version.ts --check`)
} else {
  console.error("usage: node scripts/version.ts <version> | --check [<version>]")
  process.exit(1)
}
