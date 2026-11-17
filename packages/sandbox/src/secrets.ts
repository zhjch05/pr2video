/**
 * Project secrets: values the app needs that nobody can make up - a real key
 * for an outside service the tour has to show working. The user sets them
 * (never by pasting them into a chat); they live on the host in
 * `.pr2video/secrets.env` (mode 600; `.pr2video/` ignores itself in git) and
 * reach every `exec` and `start` in the sandbox as environment variables.
 * Recorded steps name them (`$STRIPE_SECRET_KEY`) and never hold them, and
 * every log and every piece of output shows `***` where a value was.
 */
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { docker } from "./docker.ts"
import { STATE_DIR } from "./state.ts"

export const SECRETS_FILE = "secrets.env"
/** Where the sandbox keeps them; sourced before every command. */
export const SECRETS_INSIDE = "/run/pr2video/secrets.env"
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/
/** Shorter values are not scrubbed: `***` in place of every "1" or "dev" would wreck the logs. */
const MIN_SCRUB = 4

export type Secrets = Record<string, string>

export function validSecretName(name: string): string {
  if (!NAME.test(name))
    throw new Error(`"${name}" is not an environment variable name (letters, digits and _)`)
  return name
}

export function secretsPath(repo: string): string {
  return join(repo, STATE_DIR, SECRETS_FILE)
}

/**
 * The project's secrets; none when the file does not exist. It is a plain
 * `.env` file (`NAME=value`, quotes optional), so the user can edit it by hand;
 * `writeSecrets` double-quotes every value.
 */
export async function readSecrets(repo: string): Promise<Secrets> {
  return parseEnvFile(await readFile(secretsPath(repo), "utf8").catch(() => ""))
}

export async function writeSecrets(repo: string, secrets: Secrets): Promise<void> {
  const dir = join(repo, STATE_DIR)
  await mkdir(dir, { recursive: true })
  // Never committed, even before the first `sandbox up` wrote this.
  await stat(join(dir, ".gitignore")).catch(() => writeFile(join(dir, ".gitignore"), "*\n"))
  const file = secretsPath(repo)
  const body = Object.entries(secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, value]) =>
        `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    )
    .join("\n")
  await writeFile(file, body ? `${body}\n` : "", { mode: 0o600 })
  await chmod(file, 0o600)
}

/**
 * A `.env` file's values: `NAME=value`, with an optional `export`, single or
 * double quotes, and `#` comments after unquoted values.
 */
export function parseEnvFile(text: string): Secrets {
  const out: Secrets = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match?.[1]) continue
    let value = match[2] ?? ""
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote))
      if (quote === '"')
        value = value.replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c))
    } else value = value.replace(/\s+#.*$/, "").trim()
    out[match[1]] = value
  }
  return out
}

function scrubbable(secrets: Secrets): Array<[string, string]> {
  return Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_SCRUB)
    .sort(([, a], [, b]) => b.length - a.length)
}

/** `text` with every secret's value replaced by `***`. */
export function scrub(text: string, secrets: Secrets): string {
  let out = text
  for (const [, value] of scrubbable(secrets)) out = out.split(value).join("***")
  return out
}

/** The secrets whose values appear in `text`. */
export function secretsIn(text: string, secrets: Secrets): Array<string> {
  return scrubbable(secrets)
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name)
}

/** Refuses a command that holds a secret's value: it would land in the journal and the logs. */
export function refuseValues(command: string, secrets: Secrets): void {
  const names = secretsIn(command, secrets)
  if (names.length)
    throw new Error(
      `the command holds the value of ${names.join(", ")}: write ${names.map((n) => `$${n}`).join(", ")} instead (every command gets the project's secrets as environment variables)`,
    )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The secrets as a file the sandbox sources: `export NAME='value'` lines. */
export function shellEnv(secrets: Secrets): string {
  return Object.entries(secrets)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n")
}

/**
 * Writes the project's secrets into a running sandbox (through stdin, so no
 * value is ever on a command line), or removes them when there are none.
 */
export async function syncSecrets(container: string, secrets: Secrets): Promise<void> {
  const body = shellEnv(secrets)
  const result = await docker(
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      body
        ? `umask 077 && mkdir -p /run/pr2video && cat > ${SECRETS_INSIDE}`
        : `rm -f ${SECRETS_INSIDE}`,
    ],
    { stdin: body ? `${body}\n` : "", timeoutMs: 30_000 },
  )
  if (result.code !== 0)
    throw new Error(`could not give the sandbox its secrets: ${result.stderr.trim()}`)
}

/** The shell that runs `$PR2VIDEO_CMD` with the secrets in its environment. */
export const WITH_SECRETS = `[ -f ${SECRETS_INSIDE} ] && . ${SECRETS_INSIDE}; eval "$PR2VIDEO_CMD"`
