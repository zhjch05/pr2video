/**
 * One sandbox per run: a privileged container from the pr2video image, with
 * its own Docker engine inside, the pull request's head checked out at
 * `/work/head` and its base at `/work/base`. Nothing of the pull request runs
 * on the host.
 *
 * The host keeps a pull-through registry mirror (Docker Hub pulls are cached
 * across runs) and the pnpm/npm caches as named volumes. The checkout lives on
 * the container's own filesystem: the repository is mounted read-only only to
 * be fetched from, since bind mounts are slow on macOS.
 *
 * Every command the agent runs goes through `exec` or `start`; with `record`
 * it lands in the run's journal, which `replay` runs again on the base commit.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { docker, dockerOrThrow, dockerReady } from "./docker.ts"
import {
  appendJournal,
  type JournalEntry,
  readJournal,
  readRecord,
  rebase,
  runDir,
  type SandboxRecord,
  tail,
  writeRecord,
} from "./state.ts"

const git = promisify(execFile)

export const HEAD_DIR = "/work/head"
export const BASE_DIR = "/work/base"
export const NETWORK = "pr2video"
export const MIRROR = "pr2video-mirror"
const MIRROR_URL = `http://${MIRROR}:5000`
const LABEL = "pr2video.run"

type Log = ((line: string) => void) | undefined

const IMAGE_DIR = fileURLToPath(new URL("../image/", import.meta.url))

/** The image's tag: a hash of everything it is built from, so a changed Dockerfile builds a new one. */
export async function imageTag(): Promise<string> {
  const hash = createHash("sha256")
  for (const name of (await readdir(IMAGE_DIR)).sort())
    hash.update(name).update(await readFile(join(IMAGE_DIR, name)))
  return `pr2video-sandbox:${hash.digest("hex").slice(0, 12)}`
}

export async function ensureImage(log?: Log): Promise<string> {
  const tag = await imageTag()
  if ((await docker(["image", "inspect", tag])).code === 0) return tag
  log?.(`building ${tag} (first run only; a few minutes)`)
  const result = await docker(["build", "-t", tag, IMAGE_DIR], {
    onOutput: (chunk) => {
      for (const line of chunk.split("\n")) if (line.trim()) log?.(line)
    },
  })
  if (result.code !== 0)
    throw new Error(
      `building the sandbox image failed:\n${tail(result.stderr || result.stdout, 4_000)}`,
    )
  return tag
}

/**
 * Creates the shared network. Docker picks its subnet from its default pools,
 * which a machine with many networks has used up ("all predefined address
 * pools have been fully subnetted"); then try a few private /24s of our own.
 */
async function createNetwork(): Promise<void> {
  const first = await docker(["network", "create", NETWORK])
  if (first.code === 0) return
  if (!/fully subnetted|overlap/i.test(first.stderr))
    throw new Error(`docker network create failed: ${first.stderr.trim()}`)
  for (let third = 77; third < 97; third++) {
    const subnet = `10.217.${third}.0/24`
    const attempt = await docker(["network", "create", "--subnet", subnet, NETWORK])
    if (attempt.code === 0) return
  }
  throw new Error(`could not create the ${NETWORK} network: ${first.stderr.trim()}`)
}

/** The network every sandbox shares with the registry mirror, and the mirror itself. */
async function ensureMirror(log?: Log): Promise<void> {
  if ((await docker(["network", "inspect", NETWORK])).code !== 0) await createNetwork()
  const state = await docker(["inspect", "--format", "{{.State.Running}}", MIRROR])
  if (state.stdout.trim() === "true") return
  if (state.code === 0) {
    await dockerOrThrow(["start", MIRROR])
    return
  }
  log?.("starting the registry mirror (caches Docker Hub pulls across runs)")
  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    MIRROR,
    "--network",
    NETWORK,
    "--restart",
    "unless-stopped",
    "-e",
    "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
    "-v",
    "pr2video-registry:/var/lib/registry",
    "registry:2",
  ])
}

async function gitOut(repo: string, args: Array<string>): Promise<string> {
  const { stdout } = await git("git", ["-C", repo, ...args])
  return stdout.trim()
}

/** The repository's root, from any directory inside it. */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    return await gitOut(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    throw new Error(`${cwd} is not inside a git repository`)
  }
}

/** The commit a pull request's base is: where the head left the default branch. */
async function defaultBase(repo: string, headSha: string): Promise<string | null> {
  const candidates: Array<string> = []
  try {
    candidates.push(await gitOut(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
  } catch {
    // no remote HEAD
  }
  candidates.push("origin/main", "origin/master", "main", "master")
  for (const ref of candidates) {
    try {
      const base = await gitOut(repo, ["merge-base", headSha, ref])
      if (base && base !== headSha) return ref
    } catch {
      // not a ref here
    }
  }
  return null
}

function containerName(run: string): string {
  return `pr2video-${run}`
}

export function validRun(run: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(run))
    throw new Error(`run "${run}" must be letters, digits, ".", "_" or "-"`)
  return run
}

async function running(container: string): Promise<boolean | null> {
  const result = await docker(["inspect", "--format", "{{.State.Running}}", container])
  if (result.code !== 0) return null
  return result.stdout.trim() === "true"
}

/** Runs `script` in the container as root, under bash. */
function inside(
  container: string,
  script: string,
  options: { timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {},
) {
  const env = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  return docker(
    ["exec", ...env, ...(options.cwd ? ["-w", options.cwd] : []), container, "bash", "-c", script],
    {
      timeoutMs: options.timeoutMs,
    },
  )
}

export type UpOptions = {
  cwd: string
  run?: string | undefined
  /** The pull request's head; HEAD by default. */
  head?: string | undefined
  /** Its base; where the head left the default branch, by default. `null`: no base. */
  base?: string | null | undefined
  log?: Log
}

export async function up(options: UpOptions): Promise<SandboxRecord> {
  const ready = await dockerReady()
  if (!ready.ok) throw new Error(ready.reason)
  const repo = await repoRoot(options.cwd)
  const headRef = options.head ?? "HEAD"
  const headSha = await gitOut(repo, ["rev-parse", "--verify", `${headRef}^{commit}`]).catch(() => {
    throw new Error(`no commit "${headRef}" in ${repo}`)
  })
  const baseRef =
    options.base === null ? null : (options.base ?? (await defaultBase(repo, headSha)))
  const baseSha = baseRef ? await gitOut(repo, ["merge-base", headSha, baseRef]) : null
  const run = validRun(options.run ?? headSha.slice(0, 10))
  const container = containerName(run)

  const state = await running(container)
  if (state !== null) {
    if (!state) await dockerOrThrow(["start", container])
    options.log?.(`sandbox ${container} is already up`)
    return readRecord(repo, run)
  }

  const image = await ensureImage(options.log)
  await ensureMirror(options.log)
  options.log?.(`starting ${container}`)
  await dockerOrThrow([
    "run",
    "-d",
    "--privileged",
    "--name",
    container,
    "--hostname",
    "sandbox",
    "--label",
    `${LABEL}=${run}`,
    "--network",
    NETWORK,
    "-e",
    `PR2VIDEO_REGISTRY_MIRROR=${MIRROR_URL}`,
    "-e",
    "npm_config_store_dir=/cache/pnpm",
    "-e",
    "NPM_CONFIG_CACHE=/cache/npm",
    "-e",
    "COREPACK_HOME=/cache/npm/corepack",
    "-e",
    "CI=1",
    "-v",
    `${repo}:/src:ro`,
    "-v",
    "pr2video-pnpm-store:/cache/pnpm",
    "-v",
    "pr2video-npm-cache:/cache/npm",
    // The inner engine's data: a volume, since overlayfs cannot sit on overlayfs.
    "-v",
    "/var/lib/docker",
    image,
  ])

  const dockerUp = await inside(
    container,
    "for i in $(seq 90); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; tail -20 /var/log/pr2video/dockerd.log; exit 1",
    { timeoutMs: 120_000 },
  )
  if (dockerUp.code !== 0)
    throw new Error(`the sandbox's Docker engine did not start:\n${dockerUp.stdout}`)

  options.log?.(
    `checking out ${headSha.slice(0, 10)}${baseSha ? ` and base ${baseSha.slice(0, 10)}` : ""}`,
  )
  const checkout = await inside(
    container,
    [
      "set -e",
      `git init -q ${HEAD_DIR}`,
      `cd ${HEAD_DIR}`,
      // Every ref the host repository has, pull request refs and remotes included.
      "git fetch -q --no-tags /src '+refs/*:refs/src/*' 'HEAD:refs/src/HEAD'",
      `git checkout -q --detach ${headSha}`,
      baseSha ? `git worktree add -q --detach ${BASE_DIR} ${baseSha}` : "true",
    ].join("\n"),
    { timeoutMs: 600_000 },
  )
  if (checkout.code !== 0) throw new Error(`checking out failed: ${checkout.stderr.trim()}`)

  const record: SandboxRecord = {
    run,
    container,
    image,
    repo,
    head: { ref: headRef, sha: headSha, dir: HEAD_DIR },
    base: baseRef && baseSha ? { ref: baseRef, sha: baseSha, dir: BASE_DIR } : null,
    createdAt: new Date().toISOString(),
  }
  await writeRecord(record)
  return record
}

async function nextLog(record: SandboxRecord, label: string): Promise<string> {
  const dir = join(runDir(record.repo, record.run), "logs")
  const count = (await readdir(dir).catch(() => [])).length
  return join(dir, `${String(count + 1).padStart(4, "0")}-${label}.log`)
}

export type ExecResult = {
  exitCode: number | null
  timedOut: boolean
  ms: number
  /** The end of each stream; the whole of both is in `log`. */
  stdout: string
  stderr: string
  log: string
}

export async function exec(
  record: SandboxRecord,
  command: string,
  options: {
    cwd?: string | undefined
    record?: boolean | undefined
    timeoutMs?: number | undefined
    onOutput?: ((chunk: string) => void) | undefined
  } = {},
): Promise<ExecResult> {
  const cwd = options.cwd ?? record.head.dir
  const started = Date.now()
  const result = await docker(
    [
      "exec",
      "-e",
      `PR2VIDEO_CMD=${command}`,
      "-w",
      cwd,
      record.container,
      "bash",
      "-lc",
      'eval "$PR2VIDEO_CMD"',
    ],
    { timeoutMs: options.timeoutMs ?? 20 * 60_000, onOutput: options.onOutput },
  )
  const ms = Date.now() - started
  const log = await nextLog(record, "exec")
  await writeFile(
    log,
    `$ ${command}\n# cwd ${cwd}, exit ${result.code}, ${ms}ms\n\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  )
  if (options.record)
    await appendJournal(record.repo, record.run, {
      kind: "exec",
      command,
      cwd,
      exitCode: result.code,
      ms,
      at: new Date().toISOString(),
    })
  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    ms,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    log,
  }
}

function validName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name))
    throw new Error(`process name "${name}" must be letters, digits, "_" or "-"`)
  return name
}

export type WaitResult = { ok: boolean; ms: number; status: string }

/** Waits until something answers HTTP on `port` inside the sandbox, or `name`'s process dies. */
export async function waitPort(
  record: SandboxRecord,
  port: number,
  options: {
    timeoutMs?: number | undefined
    name?: string | undefined
    path?: string | undefined
  } = {},
): Promise<WaitResult> {
  const path = options.path ?? "/"
  if (!/^\/[\w\-./?=&%~]*$/.test(path)) throw new Error(`--path must start with / (got "${path}")`)
  const timeoutS = Math.ceil((options.timeoutMs ?? 180_000) / 1_000)
  const pidCheck = options.name
    ? `if ! kill -0 "$(cat /run/pr2video/${validName(options.name)}.pid 2>/dev/null)" 2>/dev/null; then echo "process ${options.name} exited"; exit 2; fi`
    : ""
  const started = Date.now()
  const result = await inside(
    record.container,
    `for i in $(seq ${timeoutS}); do
       code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' 'http://127.0.0.1:${port}${path}' 2>/dev/null)
       if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "HTTP $code on ${path}"; exit 0; fi
       ${pidCheck}
       sleep 1
     done
     echo "nothing answered on port ${port} after ${timeoutS}s"; exit 1`,
    { timeoutMs: (timeoutS + 30) * 1_000 },
  )
  return { ok: result.code === 0, ms: Date.now() - started, status: result.stdout.trim() }
}

/** Starts a long-running process (a server, a watcher) in the background, logged to `/var/log/pr2video/<name>.log`. */
export async function start(
  record: SandboxRecord,
  name: string,
  command: string,
  options: {
    cwd?: string | undefined
    port?: number | undefined
    /** What to ask for on `port` while waiting; `/` by default. */
    path?: string | undefined
    record?: boolean | undefined
    timeoutMs?: number | undefined
  } = {},
): Promise<{ pid: number; wait: WaitResult | null }> {
  validName(name)
  const cwd = options.cwd ?? record.head.dir
  await stop(record, name)
  const launched = await inside(
    record.container,
    `setsid nohup bash -lc "$PR2VIDEO_CMD" > /var/log/pr2video/${name}.log 2>&1 < /dev/null &
     echo $! > /run/pr2video/${name}.pid
     cat /run/pr2video/${name}.pid`,
    { env: { PR2VIDEO_CMD: command }, cwd, timeoutMs: 30_000 },
  )
  if (launched.code !== 0) throw new Error(`could not start ${name}: ${launched.stderr.trim()}`)
  if (options.record)
    await appendJournal(record.repo, record.run, {
      kind: "start",
      name,
      command,
      cwd,
      port: options.port ?? null,
      path: options.path ?? null,
      at: new Date().toISOString(),
    })
  const pid = Number.parseInt(launched.stdout.trim(), 10)
  const wait = options.port
    ? await waitPort(record, options.port, {
        timeoutMs: options.timeoutMs,
        name,
        path: options.path,
      })
    : null
  return { pid, wait }
}

/** Stops a background process and everything it started. */
export async function stop(record: SandboxRecord, name: string): Promise<boolean> {
  validName(name)
  const result = await inside(
    record.container,
    `f=/run/pr2video/${name}.pid; [ -f "$f" ] || exit 3
     pid=$(cat "$f"); rm -f "$f"
     kill -0 "$pid" 2>/dev/null || exit 3
     kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
     for i in $(seq 10); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.5; done
     kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid"`,
    { timeoutMs: 30_000 },
  )
  return result.code === 0
}

export type ProcessInfo = { name: string; pid: number; running: boolean }

export async function processes(record: SandboxRecord): Promise<Array<ProcessInfo>> {
  const result = await inside(
    record.container,
    `for f in /run/pr2video/*.pid; do [ -f "$f" ] || continue
       n=$(basename "$f" .pid); p=$(cat "$f")
       if kill -0 "$p" 2>/dev/null; then echo "$n $p 1"; else echo "$n $p 0"; fi
     done`,
  )
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", pid = "0", alive = "0"] = line.split(" ")
      return { name, pid: Number(pid), running: alive === "1" }
    })
}

export async function logs(record: SandboxRecord, name: string, lines = 100): Promise<string> {
  const file = name === "dockerd" ? "dockerd" : validName(name)
  const result = await inside(
    record.container,
    `tail -n ${Math.max(1, Math.floor(lines))} /var/log/pr2video/${file}.log`,
  )
  if (result.code !== 0) throw new Error(`no log for "${name}"`)
  return result.stdout
}

export type ReplayStep = { entry: JournalEntry; ok: boolean; detail: string; log?: string }

/**
 * Runs the journal's recorded steps again: every background process is
 * stopped first, and the replay stops at the first step that fails. On the
 * base (the default) each step is moved from `/work/head` to `/work/base`; on
 * the head it runs as recorded - the way back after recording the base.
 */
export async function replay(
  record: SandboxRecord,
  options: {
    side?: "head" | "base" | undefined
    onStep?: ((step: ReplayStep) => void) | undefined
    onOutput?: ((chunk: string) => void) | undefined
  } = {},
): Promise<{ ok: boolean; steps: Array<ReplayStep> }> {
  const side = options.side ?? "base"
  const base = record.base
  if (side === "base" && !base)
    throw new Error("this sandbox has no base checkout (it was started with --no-base)")
  const journal = await readJournal(record.repo, record.run)
  if (!journal.length)
    throw new Error("the journal is empty: record setup steps with `--record` first")
  for (const process of await processes(record))
    if (process.running) await stop(record, process.name)
  const steps: Array<ReplayStep> = []
  for (const original of journal) {
    const entry = side === "base" && base ? rebase(original, record.head.dir, base.dir) : original
    let step: ReplayStep
    if (entry.kind === "exec") {
      const result = await exec(record, entry.command, {
        cwd: entry.cwd,
        onOutput: options.onOutput,
      })
      step = {
        entry,
        ok: result.exitCode === 0,
        detail:
          result.exitCode === 0
            ? `ok in ${result.ms}ms`
            : `exit ${result.exitCode}: ${result.stderr.slice(-500)}`,
        log: result.log,
      }
    } else {
      const started = await start(record, entry.name, entry.command, {
        cwd: entry.cwd,
        port: entry.port ?? undefined,
        path: entry.path ?? undefined,
      })
      step = {
        entry,
        ok: started.wait ? started.wait.ok : true,
        detail: started.wait ? started.wait.status : `started (pid ${started.pid})`,
      }
    }
    steps.push(step)
    options.onStep?.(step)
    if (!step.ok) return { ok: false, steps }
  }
  return { ok: true, steps }
}

/** Copies a host file or folder into the sandbox, creating the folder it goes in. */
export async function copyIn(record: SandboxRecord, from: string, to: string): Promise<void> {
  if (!to.startsWith("/")) throw new Error(`the sandbox path must be absolute (got "${to}")`)
  const parent = to.endsWith("/") ? to : to.slice(0, to.lastIndexOf("/")) || "/"
  await inside(record.container, `mkdir -p '${parent.replace(/'/g, "")}'`)
  await dockerOrThrow(["cp", from, `${record.container}:${to}`])
}

export async function down(record: SandboxRecord): Promise<void> {
  await docker(["rm", "-f", "-v", record.container])
}

export async function list(): Promise<
  Array<{ run: string; container: string; state: string; created: string }>
> {
  const out = await dockerOrThrow([
    "ps",
    "-a",
    "--filter",
    `label=${LABEL}`,
    "--format",
    `{{.Label "${LABEL}"}}\t{{.Names}}\t{{.State}}\t{{.CreatedAt}}`,
  ])
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [run = "", container = "", state = "", created = ""] = line.split("\t")
      return { run, container, state, created }
    })
}

/** The sandbox a command means: `run`, else the repository's current one. */
export async function resolveRecord(cwd: string, run?: string): Promise<SandboxRecord> {
  const repo = await repoRoot(cwd)
  const { currentRun } = await import("./state.ts")
  const chosen = run ?? (await currentRun(repo))
  if (!chosen) throw new Error("no sandbox yet: start one with `pr2video sandbox up`")
  const record = await readRecord(repo, validRun(chosen))
  if ((await running(record.container)) !== true)
    throw new Error(
      `sandbox ${record.container} is not running: \`pr2video sandbox up --run ${record.run}\``,
    )
  return record
}
