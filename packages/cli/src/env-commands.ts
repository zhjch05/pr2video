/**
 * `pr2video sandbox env ...`: the project's secrets (see the sandbox's
 * `secrets.ts`). Values only ever go from the user's keyboard, stdin or a file
 * they name into `.pr2video/secrets.env`: no command prints one, so an agent
 * can run every command here except typing the value itself.
 */
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  list,
  parseEnvFile,
  readSecrets,
  repoRoot,
  runDir,
  secretsPath,
  syncSecrets,
  validSecretName,
  writeSecrets,
} from "@pr2video/sandbox"

export const ENV_HELP = `Secrets (values the app needs that nobody can make up: a real key for an outside service):
  pr2video sandbox env set <NAME>               Ask for the value without echoing it (or read it from stdin);
                                                run it yourself in a terminal - never paste a secret into a chat
  pr2video sandbox env import <file> <NAME,...> Copy those names' values from a .env file you name
  pr2video sandbox env ls | rm <NAME>           The names set (never the values) | forget one
  Every exec and start gets them as environment variables (write $NAME in commands, never the
  value); logs and output show *** in their place. Kept in .pr2video/secrets.env, never committed.`

/** Reads a value without showing it: hidden keystrokes on a terminal, else all of stdin. */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let text = ""
    for await (const chunk of stdin) text += chunk
    return text.replace(/\r?\n$/, "")
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = ""
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData)
            process.stderr.write("\n")
            resolve(value)
            return
          }
          if (char === "\u0003") {
            stdin.off("data", onData)
            process.stderr.write("\n")
            reject(new Error("cancelled"))
            return
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
          else value += char
        }
      }
      stdin.on("data", onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}

/** Gives the secrets to every running sandbox of this project; returns how many. */
async function syncRunning(repo: string): Promise<number> {
  const secrets = await readSecrets(repo)
  let synced = 0
  for (const sandbox of await list().catch(() => [])) {
    if (sandbox.state !== "running") continue
    const ours = await access(join(runDir(repo, sandbox.run), "sandbox.json")).then(
      () => true,
      () => false,
    )
    if (!ours) continue
    await syncSecrets(sandbox.container, secrets)
    synced++
  }
  return synced
}

export async function envCommand(
  args: ReadonlyArray<string>,
  flags: { json?: boolean | undefined },
): Promise<number> {
  const [sub, ...rest] = args
  const repo = await repoRoot(process.cwd())
  const say = (line: string) => {
    if (!flags.json) console.log(line)
  }
  const secrets = await readSecrets(repo)
  const finish = async (changed: Array<string>, verb: string) => {
    const synced = await syncRunning(repo)
    if (flags.json)
      console.log(JSON.stringify({ ok: true, [verb]: changed, sandboxes: synced }, null, 2))
    else
      say(
        `${verb} ${changed.join(", ")} in ${secretsPath(repo)}` +
          (synced ? `; given to ${synced} running sandbox${synced === 1 ? "" : "es"}` : ""),
      )
    return 0
  }
  switch (sub) {
    case "set": {
      const name = validSecretName(rest[0] ?? "")
      const value = await readHidden(`value for ${name} (not shown): `)
      if (!value) throw new Error(`no value given for ${name}`)
      await writeSecrets(repo, { ...secrets, [name]: value })
      return finish([name], "set")
    }
    case "import": {
      const [file, names] = rest
      if (!file || !names)
        throw new Error("usage: pr2video sandbox env import <file> <NAME,NAME,...>")
      const wanted = names.split(",").map((n) => validSecretName(n.trim()))
      const found = parseEnvFile(await readFile(file, "utf8"))
      const missing = wanted.filter((n) => !found[n])
      if (missing.length) throw new Error(`${file} has no value for ${missing.join(", ")}`)
      await writeSecrets(repo, {
        ...secrets,
        ...Object.fromEntries(wanted.map((n) => [n, found[n] as string])),
      })
      return finish(wanted, "imported")
    }
    case "rm": {
      const name = validSecretName(rest[0] ?? "")
      if (!(name in secrets)) throw new Error(`${name} is not set`)
      const { [name]: _gone, ...left } = secrets
      await writeSecrets(repo, left)
      return finish([name], "removed")
    }
    case "ls":
    case undefined: {
      const names = Object.keys(secrets).sort()
      if (flags.json) console.log(JSON.stringify({ names }, null, 2))
      else say(names.length ? names.join("\n") : "no secrets set")
      return 0
    }
    default:
      throw new Error(ENV_HELP)
  }
}
