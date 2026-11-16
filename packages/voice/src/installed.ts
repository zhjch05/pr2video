/**
 * Optional packages (kokoro-js, Playwright) found wherever the user put them:
 * beside pr2video, or installed globally next to a global pr2video. Node does
 * not look in the global folder by itself, so `npm i -g pr2video playwright`
 * would otherwise leave pr2video unable to import Playwright.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

let roots: Array<string> | null = null

/**
 * The global package folders that exist: npm's (from its prefix setting, or
 * beside the running node, as npm defaults it), then whatever `npm root -g`
 * and `pnpm root -g` say. npm's output is not enough on its own: it masks
 * parts of paths that look like secrets.
 */
function globalRoots(): Array<string> {
  if (roots) return roots
  const prefixes = [
    process.env.npm_config_prefix,
    process.env.PREFIX,
    dirname(dirname(process.execPath)),
  ]
  const found = prefixes.flatMap((prefix) =>
    prefix
      ? [
          process.platform === "win32"
            ? join(prefix, "node_modules")
            : join(prefix, "lib", "node_modules"),
        ]
      : [],
  )
  for (const tool of ["npm", "pnpm"]) {
    try {
      found.push(
        execFileSync(tool, ["root", "-g"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        }).trim(),
      )
    } catch {
      // not installed
    }
  }
  roots = [...new Set(found)].filter((root) => root && existsSync(root))
  return roots
}

type Exports = string | { [condition: string]: Exports } | null | undefined

/** A package's ESM entry from its `exports` (or `module`/`main`). */
function entryOf(dir: string): string | null {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Exports
    module?: string
    main?: string
  }
  const pick = (value: Exports): string | null => {
    if (typeof value === "string") return value
    if (!value) return null
    if ("." in value) return pick(value["."])
    for (const condition of ["node", "import", "default", "require"])
      if (condition in value) {
        const found = pick(value[condition])
        if (found) return found
      }
    return null
  }
  const entry = pick(manifest.exports) ?? manifest.module ?? manifest.main ?? "index.js"
  return join(dir, entry)
}

/** How the caller resolves a package from its own module (`(n) => import.meta.resolve(n)`). */
export type Resolve = (name: string) => string

/**
 * Where `name` resolves from: beside the caller (`resolve` is the caller's
 * own, since what a package can see depends on where it is installed), else
 * a global folder; null when it is nowhere.
 */
export function resolveInstalled(
  name: string,
  resolve: Resolve = (n) => import.meta.resolve(n),
): string | null {
  try {
    return resolve(name)
  } catch {
    // not beside the caller
  }
  for (const root of globalRoots()) {
    const dir = join(root, name)
    if (!existsSync(join(dir, "package.json"))) continue
    const entry = entryOf(dir)
    if (entry && existsSync(entry)) return pathToFileURL(entry).href
  }
  return null
}

/** Imports an optional package from wherever it is installed; null when it is not. */
export async function importInstalled<T>(name: string, resolve?: Resolve): Promise<T | null> {
  const url = resolveInstalled(name, resolve)
  if (!url) return null
  try {
    return (await import(url)) as T
  } catch {
    return null
  }
}
