/**
 * What pr2video keeps in Docker, and the policy that keeps it small.
 *
 * Per run: a sandbox container (its checkout and installed dependencies, a
 * few GB) and a volume for its own Docker engine (the app's services and
 * their data). Shared by every run: the sandbox image, the pnpm and npm
 * caches, and a registry mirror of Docker Hub pulls. The shared parts make
 * every later run faster; a sandbox only helps while its tour is still being
 * worked on, and costs memory while it runs.
 *
 * So: a finished sandbox sleeps (stopped, its memory freed, its disk kept,
 * any command wakes it); one left running and unused for an hour is put to
 * sleep; one asleep for three days, or beyond the newest three, is removed;
 * an image no sandbox uses is removed; a cache over 10 GB is emptied. The
 * sweep runs when a sandbox starts or sleeps - there is no daemon - and the
 * limits come from environment variables (`policyFromEnv`). A run's setup
 * journal, saved data and tour live in the project's `.pr2video/` folder,
 * not in Docker, so removing a sandbox loses none of them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { docker, dockerOrThrow } from "./docker.ts"

export const LABEL = "pr2video.run"
/** The network sandboxes made before 0.0.11 share; each new one has its own (`sandboxNetwork`). */
export const NETWORK = "pr2video"
export const MIRROR = "pr2video-mirror"
export const MIRROR_VOLUME = "pr2video-registry"
export const CACHE_VOLUMES = ["pr2video-pnpm-store", "pr2video-npm-cache"] as const
export const IMAGE_REPO = "pr2video-sandbox"
/** Touched inside a sandbox by every command that uses it. */
export const USED_FILE = "/run/pr2video/last-used"
/** What was running when the sandbox went to sleep, to start again when it wakes. */
export const AWAKE_CONTAINERS = "/run/pr2video/awake-containers"
export const AWAKE_PROCESSES = "/run/pr2video/awake-processes"

/** A sandbox's own network: it reaches the registry mirror and the internet, not other sandboxes. */
export function sandboxNetwork(run: string): string {
  return `pr2video-net-${run}`
}

/** The volume holding a sandbox's own Docker engine (its services' images, containers and data). */
export function engineVolume(run: string): string {
  return `pr2video-docker-${run}`
}

export type Policy = {
  /** Put a running sandbox to sleep after this long unused; null: never. */
  idleMs: number | null
  /** Remove a sleeping sandbox after this long unused; null: never. */
  ttlMs: number | null
  /** Keep at most this many sandboxes (running ones in use are never removed); null: no limit. */
  keep: number | null
  /** Empty a shared cache (pnpm, npm, the registry mirror) above this size; null: never. */
  cacheMaxBytes: number | null
}

export const DEFAULT_POLICY: Policy = {
  idleMs: 60 * 60_000,
  ttlMs: 3 * 24 * 60 * 60_000,
  keep: 3,
  cacheMaxBytes: 10e9,
}

const OFF = /^(off|never|none|0)$/i

/** `30m`, `2h`, `3d`, `45s`; `off` (or `0`) turns the rule off. */
export function parseDuration(value: string, name: string): number | null {
  const text = value.trim()
  if (OFF.test(text)) return null
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(text)
  if (!match) throw new Error(`${name} is a duration like 30m, 2h or 3d, or off (got "${value}")`)
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    (match[2] ?? "h").toLowerCase() as "s" | "m" | "h" | "d"
  ]
  return Number(match[1]) * unit
}

/** `500m`, `10g`, `1.5g`; `off` (or `0`) turns the rule off. */
export function parseBytes(value: string, name: string): number | null {
  const text = value.trim()
  if (OFF.test(text)) return null
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|g|t)b?$/i.exec(text)
  if (!match) throw new Error(`${name} is a size like 500m or 10g, or off (got "${value}")`)
  const unit = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[
    (match[2] ?? "g").toLowerCase() as "k" | "m" | "g" | "t"
  ]
  return Number(match[1]) * unit
}

/**
 * The policy, with any of these set:
 * - `PR2VIDEO_SANDBOX_IDLE` (default 1h): put a running sandbox to sleep after this long unused
 * - `PR2VIDEO_SANDBOX_TTL` (default 3d): remove a sleeping sandbox after this long unused
 * - `PR2VIDEO_KEEP_SANDBOXES` (default 3): the most sandboxes to keep
 * - `PR2VIDEO_CACHE_MAX` (default 10g): empty a shared cache above this size
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
  const policy = { ...DEFAULT_POLICY }
  if (env.PR2VIDEO_SANDBOX_IDLE)
    policy.idleMs = parseDuration(env.PR2VIDEO_SANDBOX_IDLE, "PR2VIDEO_SANDBOX_IDLE")
  if (env.PR2VIDEO_SANDBOX_TTL)
    policy.ttlMs = parseDuration(env.PR2VIDEO_SANDBOX_TTL, "PR2VIDEO_SANDBOX_TTL")
  if (env.PR2VIDEO_KEEP_SANDBOXES) {
    const text = env.PR2VIDEO_KEEP_SANDBOXES.trim()
    if (/^(off|never|none)$/i.test(text)) policy.keep = null
    else {
      const n = Number(text)
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`PR2VIDEO_KEEP_SANDBOXES is a whole number or off (got "${text}")`)
      policy.keep = n
    }
  }
  if (env.PR2VIDEO_CACHE_MAX)
    policy.cacheMaxBytes = parseBytes(env.PR2VIDEO_CACHE_MAX, "PR2VIDEO_CACHE_MAX")
  return policy
}

/** What one sandbox may use; null: no limit. */
export type Limits = {
  memoryBytes: number | null
  cpus: number | null
  pids: number | null
}

/**
 * The limits a new sandbox gets, with any of these set (each takes `off`):
 * - `PR2VIDEO_SANDBOX_MEMORY` (default 8g): memory for everything in it, its services included
 * - `PR2VIDEO_SANDBOX_CPUS` (default half of Docker's, at least 2)
 * - `PR2VIDEO_SANDBOX_PIDS` (default 8192): processes and threads, against a fork bomb
 */
export function limitsFromEnv(dockerCpus: number, env: NodeJS.ProcessEnv = process.env): Limits {
  const limits: Limits = {
    memoryBytes: 8e9,
    cpus: Math.max(2, Math.floor(dockerCpus / 2)),
    pids: 8192,
  }
  if (env.PR2VIDEO_SANDBOX_MEMORY)
    limits.memoryBytes = parseBytes(env.PR2VIDEO_SANDBOX_MEMORY, "PR2VIDEO_SANDBOX_MEMORY")
  for (const [key, name, whole] of [
    ["cpus", "PR2VIDEO_SANDBOX_CPUS", false],
    ["pids", "PR2VIDEO_SANDBOX_PIDS", true],
  ] as const) {
    const text = env[name]?.trim()
    if (!text) continue
    if (OFF.test(text)) {
      limits[key] = null
      continue
    }
    const n = Number(text)
    if (!(n > 0) || (whole && !Number.isInteger(n)))
      throw new Error(`${name} is a ${whole ? "whole " : ""}number or off (got "${text}")`)
    limits[key] = n
  }
  return limits
}

/** `docker run` flags for `limits`; a CPU limit above what Docker has is left out. */
export function limitFlags(limits: Limits, dockerCpus: number): Array<string> {
  return [
    ...(limits.memoryBytes !== null ? ["--memory", String(Math.round(limits.memoryBytes))] : []),
    ...(limits.cpus !== null && limits.cpus < dockerCpus ? ["--cpus", String(limits.cpus)] : []),
    ...(limits.pids !== null ? ["--pids-limit", String(limits.pids)] : []),
  ]
}

export type SandboxInfo = {
  run: string
  container: string
  running: boolean
  image: string
  createdAt: Date
  /** The last command that used it; for a stopped one, when it stopped. */
  lastUsed: Date
  /** The container's own disk (checkout, dependencies), with `sizes`. */
  diskBytes?: number | undefined
  /** Memory in use now, with `sizes`, for a running one. */
  memoryBytes?: number | undefined
}

/** Docker's sizes ("5.77GB", "953.5MiB", "1.31GB (virtual 3.81GB)") in bytes. */
export function dockerBytes(text: string): number | undefined {
  const match = /^([\d.]+)\s*([kKMGT]?i?B)/.exec(text.trim())
  if (!match) return undefined
  const unit = match[2] ?? "B"
  const power = { B: 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[unit[0] as "B"] ?? 0
  return Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** power
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "-"
  if (bytes >= 0.995e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} kB`
}

/** Every pr2video sandbox on this machine, with when each was last used. */
export async function sandboxes(options: { sizes?: boolean } = {}): Promise<Array<SandboxInfo>> {
  const names = (
    await dockerOrThrow(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"])
  )
    .split("\n")
    .filter(Boolean)
  if (!names.length) return []
  const inspected = JSON.parse(await dockerOrThrow(["inspect", ...names])) as Array<{
    Name: string
    Created: string
    Config: { Image: string; Labels: Record<string, string> }
    State: { Running: boolean; StartedAt: string; FinishedAt: string }
  }>
  const found = await Promise.all(
    inspected.map(async (c): Promise<SandboxInfo> => {
      const container = c.Name.replace(/^\//, "")
      let lastUsed = new Date(c.State.Running ? c.State.StartedAt : c.State.FinishedAt)
      if (c.State.Running) {
        const used = await docker(["exec", container, "stat", "-c", "%Y", USED_FILE])
        const seconds = Number(used.stdout.trim())
        if (used.code === 0 && seconds > 0 && seconds * 1000 > lastUsed.getTime())
          lastUsed = new Date(seconds * 1000)
      }
      if (Number.isNaN(lastUsed.getTime())) lastUsed = new Date(c.Created)
      return {
        run: c.Config.Labels[LABEL] ?? container,
        container,
        running: c.State.Running,
        image: c.Config.Image,
        createdAt: new Date(c.Created),
        lastUsed,
      }
    }),
  )
  if (options.sizes) {
    const disk = await docker([
      "ps",
      "-a",
      "--size",
      "--filter",
      `label=${LABEL}`,
      "--format",
      "{{.Names}}\t{{.Size}}",
    ])
    const running = found.filter((s) => s.running).map((s) => s.container)
    const memory = running.length
      ? await docker(["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", ...running])
      : null
    const column = (out: string | undefined) =>
      new Map(
        (out ?? "")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t") as [string, string]),
      )
    const disks = column(disk.stdout)
    const memories = column(memory?.stdout)
    for (const s of found) {
      s.diskBytes = dockerBytes(disks.get(s.container) ?? "")
      s.memoryBytes = s.running ? dockerBytes(memories.get(s.container) ?? "") : undefined
    }
  }
  return found.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime())
}

export type Action =
  | { kind: "sleep"; container: string; reason: string }
  | { kind: "remove"; container: string; run: string; reason: string }

/**
 * What the policy does to these sandboxes now. `protect` is the run being
 * started or used: never put to sleep or removed, and counted first.
 */
export function planSweep(
  list: ReadonlyArray<SandboxInfo>,
  policy: Policy,
  now: number,
  protect?: string | undefined,
): Array<Action> {
  const actions: Array<Action> = []
  const ago = (s: SandboxInfo) => describeAge(now - s.lastUsed.getTime())
  // Newest first, the protected one ahead of all.
  const ordered = [...list].sort(
    (a, b) =>
      Number(b.run === protect) - Number(a.run === protect) ||
      b.lastUsed.getTime() - a.lastUsed.getTime(),
  )
  for (const [index, s] of ordered.entries()) {
    if (s.run === protect) continue
    const idle = now - s.lastUsed.getTime()
    const sleeping = !s.running || (policy.idleMs !== null && idle > policy.idleMs)
    if (sleeping && policy.ttlMs !== null && idle > policy.ttlMs) {
      actions.push({
        kind: "remove",
        container: s.container,
        run: s.run,
        reason: `unused for ${ago(s)}`,
      })
      continue
    }
    if (sleeping && policy.keep !== null && index >= policy.keep) {
      actions.push({
        kind: "remove",
        container: s.container,
        run: s.run,
        reason: `beyond the newest ${policy.keep} sandboxes (last used ${ago(s)} ago)`,
      })
      continue
    }
    if (s.running && sleeping)
      actions.push({ kind: "sleep", container: s.container, reason: `unused for ${ago(s)}` })
  }
  return actions
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

/**
 * Puts a sandbox to sleep: notes what is running, stops its services the
 * way they expect (so a database shuts down cleanly), then stops the
 * container. Its disk stays; `wake` starts the same things again.
 */
export async function sleepContainer(container: string): Promise<void> {
  await docker(
    [
      "exec",
      container,
      "bash",
      "-c",
      `mkdir -p /run/pr2video
       docker ps -q > ${AWAKE_CONTAINERS} 2>/dev/null || : > ${AWAKE_CONTAINERS}
       : > ${AWAKE_PROCESSES}
       for f in /run/pr2video/*.pid; do [ -f "$f" ] || continue
         kill -0 "$(cat "$f")" 2>/dev/null && basename "$f" .pid >> ${AWAKE_PROCESSES}
       done
       ids=$(cat ${AWAKE_CONTAINERS}); [ -z "$ids" ] || docker stop -t 20 $ids >/dev/null 2>&1
       # The engine too, so it removes its pid file: a stale one stops it starting on wake.
       pid=$(cat /var/run/docker.pid 2>/dev/null)
       if [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; then
         for i in $(seq 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
       fi
       true`,
    ],
    { timeoutMs: 120_000 },
  )
  await dockerOrThrow(["stop", "-t", "5", container])
}

/** Removes a sandbox, its Docker engine's volume and its network. */
export async function removeSandbox(container: string, run: string): Promise<void> {
  await docker(["rm", "-f", "-v", container])
  await docker(["volume", "rm", "-f", engineVolume(run)])
  await removeNetwork(sandboxNetwork(run))
}

async function removeNetwork(name: string): Promise<void> {
  if ((await docker(["network", "inspect", name])).code !== 0) return
  await docker(["network", "disconnect", "-f", name, MIRROR])
  await docker(["network", "rm", name])
}

type Log = ((line: string) => void) | undefined

export type SweepResult = {
  slept: Array<string>
  removed: Array<string>
  images: Array<string>
  volumes: Array<string>
  caches: Array<string>
}

/** When the caches were last measured: at most once a day, since `du` over a big store takes a while. */
const CACHE_STAMP = join(homedir(), ".cache", "pr2video", "cache-checked")

/**
 * Applies the policy: sleeps, removes, then unused images, orphaned engine
 * volumes and oversized caches. Never throws: cleaning up must not stop a run.
 */
export async function sweep(options: {
  currentImage: string
  protect?: string | undefined
  policy?: Policy | undefined
  dryRun?: boolean | undefined
  /** Measure the caches now, not at most once a day. */
  checkCaches?: boolean | undefined
  log?: Log
}): Promise<SweepResult> {
  const result: SweepResult = { slept: [], removed: [], images: [], volumes: [], caches: [] }
  const say = (line: string) => options.log?.(line)
  const dry = options.dryRun === true
  try {
    const policy = options.policy ?? policyFromEnv()
    const list = await sandboxes()
    for (const action of planSweep(list, policy, Date.now(), options.protect)) {
      say(
        `${dry ? "would " : ""}${action.kind === "sleep" ? "put to sleep" : "remove"} ${action.container}: ${action.reason}`,
      )
      if (action.kind === "sleep") {
        if (!dry) await sleepContainer(action.container).catch(() => undefined)
        result.slept.push(action.container)
      } else {
        if (!dry) await removeSandbox(action.container, action.run)
        result.removed.push(action.container)
      }
    }
    const remaining = list.filter((s) => !result.removed.includes(s.container))

    // Images: the current one and any a remaining sandbox was made from.
    const inUse = new Set([options.currentImage, ...remaining.map((s) => s.image)])
    const images = (
      await docker(["image", "ls", IMAGE_REPO, "--format", "{{.Repository}}:{{.Tag}}"])
    ).stdout
      .split("\n")
      .filter((tag) => tag && !tag.endsWith(":<none>") && !inUse.has(tag))
    for (const tag of images) {
      if (!dry && (await docker(["rmi", tag])).code !== 0) continue
      say(`${dry ? "would remove" : "removed"} the old image ${tag}`)
      result.images.push(tag)
    }

    // Engine volumes whose sandbox is gone.
    const runs = new Set(remaining.map((s) => s.run))
    if (options.protect) runs.add(options.protect)
    const volumes = (await docker(["volume", "ls", "-q", "--filter", `label=${LABEL}`])).stdout
      .split("\n")
      .filter((name) => name && ![...runs].some((run) => engineVolume(run) === name))
    for (const name of volumes) {
      if (!dry) await docker(["volume", "rm", "-f", name])
      say(`${dry ? "would remove" : "removed"} the orphaned volume ${name}`)
      result.volumes.push(name)
    }
    // Networks whose sandbox is gone.
    const networks = (
      await docker(["network", "ls", "--filter", `label=${LABEL}`, "--format", "{{.Name}}"])
    ).stdout
      .split("\n")
      .filter((name) => name && ![...runs].some((run) => sandboxNetwork(run) === name))
    for (const name of networks) {
      if (!dry) await removeNetwork(name)
      say(`${dry ? "would remove" : "removed"} the orphaned network ${name}`)
    }

    // Caches, only while no sandbox runs (one might be installing from them).
    const awake = remaining.filter((s) => s.running && !result.slept.includes(s.container))
    const max = policy.cacheMaxBytes
    if (max !== null && awake.length && options.checkCaches)
      say(
        `caches not checked: ${awake.length} sandbox${awake.length === 1 ? " is" : "es are"} running and may be installing from them`,
      )
    if (max !== null && !awake.length && (options.checkCaches || (await cacheCheckDue()))) {
      for (const cache of await cacheSizes(options.currentImage)) {
        if (cache.bytes === undefined || cache.bytes <= max) {
          if (options.checkCaches)
            say(`${cache.volume}: ${formatBytes(cache.bytes)}, under ${formatBytes(max)} (kept)`)
          continue
        }
        say(
          `${dry ? "would empty" : "emptied"} ${cache.volume}: ${formatBytes(cache.bytes)}, over ${formatBytes(max)} (PR2VIDEO_CACHE_MAX)`,
        )
        if (!dry) await emptyVolume(cache.volume, options.currentImage)
        result.caches.push(cache.volume)
      }
      if (!dry) await stampCacheCheck()
    }
  } catch (error) {
    say(`cleanup skipped: ${(error as Error).message}`)
  }
  return result
}

async function cacheCheckDue(): Promise<boolean> {
  const last = Number(await readFile(CACHE_STAMP, "utf8").catch(() => "0"))
  return Date.now() - last > 24 * 3_600_000
}

async function stampCacheCheck(): Promise<void> {
  await mkdir(join(homedir(), ".cache", "pr2video"), { recursive: true })
  await writeFile(CACHE_STAMP, String(Date.now()))
}

/** The shared caches' sizes, measured with `du` in a throwaway container. */
export async function cacheSizes(
  image: string,
): Promise<Array<{ volume: string; bytes: number | undefined }>> {
  const existing = new Set(
    (await docker(["volume", "ls", "-q"])).stdout.split("\n").filter(Boolean),
  )
  const names = [...CACHE_VOLUMES, MIRROR_VOLUME].filter((name) => existing.has(name))
  return Promise.all(
    names.map(async (volume) => {
      const du = await docker(
        ["run", "--rm", "-v", `${volume}:/v:ro`, "--entrypoint", "du", image, "-sb", "/v"],
        { timeoutMs: 300_000 },
      )
      const bytes = Number(du.stdout.split(/\s/)[0])
      return { volume, bytes: du.code === 0 && Number.isFinite(bytes) ? bytes : undefined }
    }),
  )
}

/** Empties a shared cache in place (its volume may still be attached to sleeping sandboxes). */
async function emptyVolume(volume: string, image: string): Promise<void> {
  const mirror = volume === MIRROR_VOLUME
  if (mirror) await docker(["stop", MIRROR])
  await docker([
    "run",
    "--rm",
    "-v",
    `${volume}:/v`,
    "--entrypoint",
    "find",
    image,
    "/v",
    "-mindepth",
    "1",
    "-delete",
  ])
  if (mirror) await docker(["start", MIRROR])
}

/**
 * Removes everything pr2video keeps in Docker: every sandbox (running ones
 * too), their volumes, the caches, the mirror, the images and the network.
 * The projects' `.pr2video/` folders stay; the next run rebuilds the rest.
 */
export async function pruneAll(
  options: { dryRun?: boolean; log?: Log } = {},
): Promise<Array<string>> {
  const dry = options.dryRun === true
  const removed: Array<string> = []
  const note = (what: string) => {
    removed.push(what)
    options.log?.(`${dry ? "would remove" : "removed"} ${what}`)
  }
  for (const s of await sandboxes()) {
    if (!dry) await removeSandbox(s.container, s.run)
    note(`sandbox ${s.container}${s.running ? " (it was running)" : ""}`)
  }
  if ((await docker(["inspect", MIRROR])).code === 0) {
    if (!dry) await docker(["rm", "-f", MIRROR])
    note(`the registry mirror ${MIRROR}`)
  }
  const volumes = new Set((await docker(["volume", "ls", "-q"])).stdout.split("\n"))
  const labelled = (await docker(["volume", "ls", "-q", "--filter", `label=${LABEL}`])).stdout
  for (const name of [...CACHE_VOLUMES, MIRROR_VOLUME, ...labelled.split("\n")]) {
    if (!name || !volumes.has(name)) continue
    volumes.delete(name)
    if (!dry) await docker(["volume", "rm", "-f", name])
    note(`volume ${name}`)
  }
  const images = (
    await docker(["image", "ls", IMAGE_REPO, "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}"])
  ).stdout
  for (const line of images.split("\n").filter(Boolean)) {
    const [id = "", tag = ""] = line.split("\t")
    if (!dry) await docker(["rmi", "-f", tag.endsWith(":<none>") ? id : tag])
    note(`image ${tag.endsWith(":<none>") ? id : tag}`)
  }
  const networks = (
    await docker(["network", "ls", "--filter", `label=${LABEL}`, "--format", "{{.Name}}"])
  ).stdout
  for (const name of [...networks.split("\n"), NETWORK]) {
    if (!name || (await docker(["network", "inspect", name])).code !== 0) continue
    if (!dry) await docker(["network", "rm", name])
    note(`network ${name}`)
  }
  return removed
}
