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
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { docker, dockerOrThrow, dockerReady } from "./docker.ts"
import {
  appendJournal,
  type DataManifest,
  type JournalEntry,
  readDataManifest,
  readJournal,
  readRecord,
  rebase,
  runDir,
  type SandboxRecord,
  STATE_DIR,
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

/** Whether `cwd` is inside a git repository. */
async function inGit(cwd: string): Promise<boolean> {
  return gitOut(cwd, ["rev-parse", "--show-toplevel"]).then(
    () => true,
    () => false,
  )
}

/**
 * The project's root, from any directory inside it: the git repository's
 * root; outside git, the nearest folder that already holds `.pr2video/`, else
 * `cwd` itself.
 */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    return await gitOut(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      if (
        await stat(join(dir, STATE_DIR)).then(
          (s) => s.isDirectory(),
          () => false,
        )
      )
        return dir
      if (dirname(dir) === dir) return resolve(cwd)
    }
  }
}

/**
 * Never copied from a working folder: dependencies and build caches the
 * sandbox installs or builds itself, version control, and pr2video's own state.
 */
export const FOLDER_EXCLUDES = [
  ".git",
  STATE_DIR,
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
]

/**
 * The remote a partial clone fetches missing files from, or null when the
 * clone is complete: `remote.<name>.promisor`, or the older
 * `extensions.partialClone`.
 */
async function promisorRemote(repo: string): Promise<string | null> {
  const promisors = await gitOut(repo, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.promisor$",
  ]).catch(() => "")
  for (const line of promisors.split("\n")) {
    const [key, value] = line.split(/\s+/)
    if (key && value === "true") return key.slice("remote.".length, -".promisor".length)
  }
  return (
    (await gitOut(repo, ["config", "--get", "extensions.partialclone"]).catch(() => "")) || null
  )
}

/** The remote to fetch missing history or objects from: the partial clone's, else origin, else the first. */
async function fetchRemote(repo: string): Promise<string | null> {
  const partial = await promisorRemote(repo)
  if (partial) return partial
  const remotes = (await gitOut(repo, ["remote"]).catch(() => "")).split("\n").filter(Boolean)
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null)
}

/**
 * Where `head` left `ref`. In a shallow clone that history may not be here
 * yet: fetch more of it (the repository's objects only - no ref or working
 * tree changes) until the two meet.
 */
async function mergeBase(repo: string, head: string, ref: string, log: Log): Promise<string> {
  const find = () => gitOut(repo, ["merge-base", head, ref])
  try {
    return await find()
  } catch (error) {
    const shallow = (await gitOut(repo, ["rev-parse", "--is-shallow-repository"])) === "true"
    const remote = shallow ? await fetchRemote(repo) : null
    if (!remote) throw error
    for (const depth of ["--deepen=50", "--deepen=500", "--unshallow"]) {
      log?.(`shallow clone: fetching more history from ${remote} (${depth}) to find the base`)
      await git("git", ["-C", repo, "fetch", "-q", "--no-tags", depth, remote], {
        maxBuffer: 64 * 1024 * 1024,
      })
      try {
        return await find()
      } catch {
        // deeper still
      }
    }
    throw error
  }
}

/**
 * A partial clone (`--filter=blob:none`) fetches files when they are read,
 * which the sandbox cannot do through its read-only mount: fetch every file
 * of `commits` that is missing, in one batch, the way git itself does.
 */
async function completeObjects(repo: string, commits: Array<string>, log: Log): Promise<void> {
  const remote = await promisorRemote(repo)
  if (!remote) return
  const { stdout } = await git(
    "git",
    ["-C", repo, "rev-list", "--objects", "--no-walk", "--missing=print", ...commits],
    { maxBuffer: 256 * 1024 * 1024 },
  )
  const missing = stdout
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1).trim())
  if (!missing.length) return
  log?.(`partial clone: fetching ${missing.length} missing files from ${remote}`)
  await new Promise<void>((done, fail) => {
    const child = spawn(
      "git",
      [
        "-C",
        repo,
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "-q",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
        remote,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", fail)
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`fetching the missing files failed: ${stderr.trim()}`)),
    )
    child.stdin.on("error", () => {}) // EPIPE if git exits early; its exit code reports it
    child.stdin.end(`${missing.join("\n")}\n`)
  })
}

/** The commit a pull request's base is: where the head left the default branch. */
async function defaultBase(repo: string, headSha: string, log: Log): Promise<string | null> {
  const candidates: Array<string> = []
  try {
    candidates.push(await gitOut(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
  } catch {
    // no remote HEAD
  }
  candidates.push("origin/main", "origin/master", "main", "master")
  for (const ref of candidates) {
    try {
      await gitOut(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      const base = await mergeBase(repo, headSha, ref, log)
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
  /**
   * An earlier run of this repository to start from: its journal and kept
   * files are copied in, and its saved data restored, ready to replay.
   */
  from?: string | undefined
  /**
   * Use the project folder as it is on disk - uncommitted and untracked files
   * included, git not needed - instead of a commit. There is no base unless
   * `base` names a commit. Always on outside a git repository.
   */
  folder?: boolean | undefined
  log?: Log
}

export async function up(options: UpOptions): Promise<SandboxRecord> {
  const ready = await dockerReady()
  if (!ready.ok) throw new Error(ready.reason)
  const repo = await repoRoot(options.cwd)
  const isGit = await inGit(repo)
  const folder = options.folder === true || !isGit
  if (folder && options.head)
    throw new Error("--head names a commit; --folder uses the folder as it is")
  if (!isGit && options.base)
    throw new Error(`--base needs a git repository, and ${repo} is not one`)

  let headSha: string | null = null
  if (!folder) {
    const headRef = options.head ?? "HEAD"
    headSha = await gitOut(repo, ["rev-parse", "--verify", `${headRef}^{commit}`]).catch(() => {
      throw new Error(`no commit "${headRef}" in ${repo}`)
    })
    const changed = await gitOut(repo, ["status", "--porcelain"]).catch(() => "")
    if (changed && !options.head)
      options.log?.(
        "note: the folder has uncommitted changes the sandbox will not see (it checks out the commit); `sandbox up --folder` takes the folder as it is",
      )
  }
  // A folder has a base only when one is asked for; a commit, where it left the default branch.
  const baseRef =
    options.base === null
      ? null
      : (options.base ??
        (folder || !headSha ? null : await defaultBase(repo, headSha, options.log)))
  const baseSha = baseRef
    ? headSha
      ? await mergeBase(repo, headSha, baseRef, options.log)
      : await gitOut(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]).catch(() => {
          throw new Error(`no commit "${baseRef}" in ${repo}`)
        })
    : null
  const commits = [headSha, baseSha].filter((sha): sha is string => sha !== null)
  if (commits.length) await completeObjects(repo, commits, options.log)
  const run = validRun(
    options.run ?? (headSha ? headSha.slice(0, 10) : `folder-${Date.now().toString(36)}`),
  )
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

  // Just the commits, without history: quick for a big repository, and all a
  // shallow or partial clone is sure to have. More history is a
  // \`git fetch /src <ref>\` away.
  const fetch = (shas: Array<string>) =>
    `git fetch -q --no-tags --depth 1 --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' /src ${shas.join(" ")}`
  const excludes = FOLDER_EXCLUDES.map((name) => `--exclude=${name}`).join(" ")
  const script = folder
    ? [
        "set -eo pipefail",
        `mkdir -p ${HEAD_DIR}`,
        // In git, what git would keep (tracked and untracked, not ignored); otherwise all but the usual caches.
        isGit
          ? `git -c safe.directory='*' -C /src ls-files -z -co --exclude-standard | tar -C /src --null --ignore-failed-read --warning=no-failed-read ${excludes} -cf - -T - | tar -C ${HEAD_DIR} -xf -`
          : `tar -C /src ${excludes} -cf - . | tar -C ${HEAD_DIR} -xf -`,
        `cd ${HEAD_DIR}`,
        // A commit of the snapshot, so the app's own git commands work and changes made in the sandbox show in git status.
        "git init -q",
        "git add -A",
        "git -c user.name=pr2video -c user.email=pr2video@localhost commit -q --no-verify --allow-empty -m 'the working folder'",
        baseSha ? fetch([baseSha]) : "true",
        baseSha ? `git worktree add -q --detach ${BASE_DIR} ${baseSha}` : "true",
        "git rev-parse HEAD >&2",
      ].join("\n")
    : [
        "set -e",
        `git init -q ${HEAD_DIR}`,
        `cd ${HEAD_DIR}`,
        fetch(commits),
        `git checkout -q --detach ${headSha}`,
        baseSha ? `git worktree add -q --detach ${BASE_DIR} ${baseSha}` : "true",
      ].join("\n")
  options.log?.(
    folder
      ? `copying the folder ${repo}${baseSha ? ` and checking out base ${baseSha.slice(0, 10)}` : ""}`
      : `checking out ${headSha?.slice(0, 10)}${baseSha ? ` and base ${baseSha.slice(0, 10)}` : ""}`,
  )
  const checkout = await inside(container, script, { timeoutMs: 600_000 })
  if (checkout.code !== 0) {
    // A sandbox with no checkout is no use, and would block the next `up`.
    await docker(["rm", "-f", "-v", container])
    throw new Error(
      `${folder ? "copying the folder" : "checking out"} failed: ${checkout.stderr.trim()}`,
    )
  }
  const snapshot = checkout.stderr.trim().split("\n").at(-1) ?? ""

  const record: SandboxRecord = {
    run,
    container,
    image,
    repo,
    head: folder
      ? { ref: "the working folder", sha: snapshot, dir: HEAD_DIR, folder: true }
      : { ref: options.head ?? "HEAD", sha: headSha ?? "", dir: HEAD_DIR },
    base: baseRef && baseSha ? { ref: baseRef, sha: baseSha, dir: BASE_DIR } : null,
    createdAt: new Date().toISOString(),
  }
  await writeRecord(record)
  if (options.from && options.from !== run) await adoptRun(record, options.from, options.log)
  return record
}

/** Copies run `from`'s setup into `record`'s run, and restores its saved data. */
async function adoptRun(record: SandboxRecord, from: string, log: Log): Promise<void> {
  const source = runDir(record.repo, from)
  const target = runDir(record.repo, record.run)
  const journal = await readJournal(record.repo, from)
  if (!journal.length) throw new Error(`run "${from}" has no recorded setup to start from`)
  await cp(join(source, "journal.jsonl"), join(target, "journal.jsonl"))
  await cp(join(source, "files"), join(target, "files"), { recursive: true }).catch(() => undefined)
  for (const name of ["scenes.json", "seed"])
    await cp(join(source, name), join(target, name), { recursive: true, force: false }).catch(
      () => undefined,
    )
  log?.(`took ${journal.length} setup steps from run ${from}`)
  const manifest = await readDataManifest(record.repo, from)
  if (!manifest) return
  log?.(
    `restoring ${from}'s saved data (${manifest.volumes.length} volumes, ${manifest.paths.length} paths, ${(manifest.bytes / 1e6).toFixed(1)} MB)`,
  )
  await mkdir(target, { recursive: true })
  await dockerOrThrow([
    "cp",
    join(source, "data.tgz"),
    `${record.container}:/tmp/pr2video-data.tgz`,
  ])
  const restored = await inside(
    record.container,
    [
      "set -e",
      ...manifest.volumes.map((v) => `docker volume create ${shellWord(v)} >/dev/null`),
      "tar -xzpf /tmp/pr2video-data.tgz -C /",
      "rm /tmp/pr2video-data.tgz",
    ].join("\n"),
    { timeoutMs: 600_000 },
  )
  if (restored.code !== 0)
    throw new Error(`restoring the saved data failed: ${restored.stderr.trim()}`)
  await writeFile(join(target, "data.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(target, "restored"), `${manifest.steps}\n`)
}

/** How many of this run's journal steps a restored snapshot covers (0 when none was restored). */
export async function restoredSteps(record: SandboxRecord): Promise<number> {
  try {
    return Number(
      (await readFile(join(runDir(record.repo, record.run), "restored"), "utf8")).trim(),
    )
  } catch {
    return 0
  }
}

function shellWord(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * Saves what setup made outside the checkouts, for a later run to start from
 * (`up --from`): every volume of the sandbox's Docker engine (its services'
 * data) and `paths` (a toolchain, a seeded file). Containers are stopped
 * while their data is copied, then started again; background processes keep
 * running. Docker's image store is never saved: the registry mirror makes
 * pulls quick.
 */
export async function saveData(
  record: SandboxRecord,
  paths: ReadonlyArray<string>,
  log?: Log,
): Promise<DataManifest> {
  for (const path of paths)
    if (!path.startsWith("/")) throw new Error(`a saved path must be absolute (got "${path}")`)
  const listed = await inside(record.container, "docker volume ls -q")
  if (listed.code !== 0) throw new Error(`listing volumes failed: ${listed.stderr.trim()}`)
  const volumes = listed.stdout.split("\n").filter(Boolean)
  if (!volumes.length && !paths.length)
    throw new Error("nothing to save: no Docker volumes, and no --path given")
  log?.(`saving ${volumes.length} volumes${paths.length ? ` and ${paths.join(", ")}` : ""}`)
  const members = [
    ...volumes.map((v) => `var/lib/docker/volumes/${v}/_data`),
    ...paths.map((p) => p.replace(/^\/+/, "")),
  ]
  const saved = await inside(
    record.container,
    [
      "set -e",
      "status=0",
      "running=$(docker ps -q)",
      '[ -z "$running" ] || docker stop -t 30 $running >/dev/null',
      `tar -czpf /tmp/pr2video-data.tgz -C / ${members.map(shellWord).join(" ")} || status=$?`,
      '[ -z "$running" ] || docker start $running >/dev/null',
      'exit "$status"',
    ].join("\n"),
    { timeoutMs: 1_200_000 },
  )
  if (saved.code !== 0) throw new Error(`saving the data failed: ${saved.stderr.trim()}`)
  const dir = runDir(record.repo, record.run)
  await dockerOrThrow(["cp", `${record.container}:/tmp/pr2video-data.tgz`, join(dir, "data.tgz")])
  await inside(record.container, "rm -f /tmp/pr2video-data.tgz")
  const manifest: DataManifest = {
    steps: (await readJournal(record.repo, record.run)).length,
    volumes,
    paths: [...paths],
    bytes: (await stat(join(dir, "data.tgz"))).size,
    savedAt: new Date().toISOString(),
  }
  await writeFile(join(dir, "data.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
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
  /** Whether the step went into the journal: asked for with `record`, and it succeeded. */
  recorded: boolean
}

export async function exec(
  record: SandboxRecord,
  command: string,
  options: {
    cwd?: string | undefined
    record?: boolean | undefined
    /** Journal it as a data step (see `JournalEntry`). */
    data?: boolean | undefined
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
  // A failed step is not journaled: replay would stop on it.
  const recorded = Boolean(options.record) && result.code === 0
  if (recorded)
    await appendJournal(record.repo, record.run, {
      kind: "exec",
      command,
      cwd,
      exitCode: result.code,
      ms,
      at: new Date().toISOString(),
      ...(options.data ? { data: true } : {}),
    })
  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    recorded,
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
    // Both loopbacks: a dev server told to listen on "localhost" often binds only ::1.
    `for i in $(seq ${timeoutS}); do
       for host in 127.0.0.1 '[::1]'; do
         code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$host:${port}${path}" 2>/dev/null)
         if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then echo "HTTP $code on ${path}"; exit 0; fi
       done
       ${pidCheck}
       sleep 1
     done
     echo "nothing answered on port ${port} (127.0.0.1 or ::1) after ${timeoutS}s"; exit 1`,
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
): Promise<{ pid: number; wait: WaitResult | null; recorded: boolean }> {
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
  const pid = Number.parseInt(launched.stdout.trim(), 10)
  const wait = options.port
    ? await waitPort(record, options.port, {
        timeoutMs: options.timeoutMs,
        name,
        path: options.path,
      })
    : null
  // Like `exec`, only a start that worked is a setup step: one whose port never answered is not.
  const recorded = options.record === true && (wait === null || wait.ok)
  if (recorded)
    await appendJournal(record.repo, record.run, {
      kind: "start",
      name,
      command,
      cwd,
      port: options.port ?? null,
      path: options.path ?? null,
      at: new Date().toISOString(),
    })
  return { pid, wait, recorded }
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
    /** Skip the data steps among the first this many: a restored snapshot already holds what they wrote. */
    restoredSteps?: number | undefined
    onStep?: ((step: ReplayStep) => void) | undefined
    onOutput?: ((chunk: string) => void) | undefined
  } = {},
): Promise<{ ok: boolean; steps: Array<ReplayStep> }> {
  const side = options.side ?? "base"
  const base = record.base
  if (side === "base" && !base)
    throw new Error(
      "this sandbox has no base (it was started with --no-base, or with --folder and no --base)",
    )
  const journal = await readJournal(record.repo, record.run)
  if (!journal.length)
    throw new Error("the journal is empty: record setup steps with `--record` first")
  for (const process of await processes(record))
    if (process.running) await stop(record, process.name)
  const steps: Array<ReplayStep> = []
  for (const [index, original] of journal.entries()) {
    const entry = side === "base" && base ? rebase(original, record.head.dir, base.dir) : original
    let step: ReplayStep
    if (entry.kind === "exec" && entry.data && index < (options.restoredSteps ?? 0)) {
      step = { entry, ok: true, detail: "skipped: the restored data holds it" }
    } else if (entry.kind === "copy") {
      const from = join(runDir(record.repo, record.run), entry.from)
      step = await copyIn(record, from, entry.to).then(
        () => ({ entry, ok: true, detail: "copied" }),
        (error: Error) => ({ entry, ok: false, detail: error.message }),
      )
    } else if (entry.kind === "exec") {
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

/**
 * Copies a host file or folder into the sandbox, creating the folder it goes
 * in. With `record`, the run keeps its own copy under `files/` and journals
 * the step, so replay copies the same content.
 */
export async function copyIn(
  record: SandboxRecord,
  from: string,
  to: string,
  options: { record?: boolean | undefined } = {},
): Promise<void> {
  if (!to.startsWith("/")) throw new Error(`the sandbox path must be absolute (got "${to}")`)
  const parent = to.endsWith("/") ? to : to.slice(0, to.lastIndexOf("/")) || "/"
  await inside(record.container, `mkdir -p '${parent.replace(/'/g, "")}'`)
  await dockerOrThrow(["cp", from, `${record.container}:${to}`])
  if (!options.record) return
  const kept = join("files", `${Date.now()}-${basename(from.replace(/\/+$/, ""))}`)
  await cp(from, join(runDir(record.repo, record.run), kept), { recursive: true })
  await appendJournal(record.repo, record.run, {
    kind: "copy",
    from: kept,
    to,
    at: new Date().toISOString(),
  })
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
