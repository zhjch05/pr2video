/**
 * `pr2video sandbox ...`: the sandbox an agent sets the pull request up in.
 * Human output streams; `--json` answers one object per command.
 */
import { access } from "node:fs/promises"

import {
  copyIn,
  down,
  dropJournalSteps,
  exec,
  type JournalEntry,
  list,
  logs,
  moveJournalStep,
  processes,
  readJournal,
  replay,
  resolveRecord,
  restoredSteps,
  type SandboxRecord,
  saveData,
  start,
  stop,
  up,
  waitPort,
} from "@pr2video/sandbox"

export type SandboxFlags = {
  json?: boolean | undefined
  run?: string | undefined
  cwd?: string | undefined
  record?: boolean | undefined
  timeout?: string | undefined
  head?: string | undefined
  base?: string | undefined
  "no-base"?: boolean | undefined
  port?: string | undefined
  tail?: string | undefined
  name?: string | undefined
  path?: string | undefined
  from?: string | undefined
  folder?: boolean | undefined
  all?: boolean | undefined
  data?: boolean | undefined
  side?: string | undefined
}

export const SANDBOX_HELP = `Sandbox (one Docker container per run; the pull request never runs on your machine):
  pr2video sandbox up [--head <ref>] [--base <ref> | --no-base] [--run <id>] [--from <run>]
                                                Check out head (/work/head) and base (/work/base) in a new sandbox;
  pr2video sandbox up --folder [--base <ref>]    Copy the project folder as it is instead (uncommitted files too,
                                                no git needed; no base unless --base names a commit).
                                                Outside a git repository, up always does this;
                                                --from starts from an earlier run's setup and saved data
                                                and replays it on the head
  pr2video sandbox exec [--cwd <dir>] [--record [--data]] [--timeout <s>] -- <command>
                                                Run a command inside; --record adds it to the setup
                                                journal if it succeeds; --data marks a step that only
                                                writes what \`save\` keeps (seeding, a toolchain)
  pr2video sandbox start <name> [--port <n> [--path <p>]] [--cwd <dir>] [--record] -- <command>
                                                Start a background process (a server); --port waits until
                                                <path> (default /) answers with a status below 500
  pr2video sandbox wait <port> [--path <p>] [--name <process>] [--timeout <s>]
  pr2video sandbox cp [--record] <host path> <sandbox path>
                                                Copy a file or folder in (a seed script, fixtures); --record
                                                keeps a copy in the run and journals it, so replay copies it too
  pr2video sandbox ps | logs <name> [--tail <n>] | stop <name>
  pr2video sandbox journal                      The recorded setup steps
  pr2video sandbox journal drop <n>[-<m>]       Remove step n, or steps n to m (a wrong step, or ones to
                                                record again; the steps after them stay)
  pr2video sandbox journal move <n> <to>        Move step n to position <to> (a step recorded again goes
                                                back where it belongs)
  pr2video sandbox save [--path <dir,dir>]      Keep the services' data (every Docker volume) and the
                                                paths, for a later run's up --from
  pr2video sandbox replay [--side base|head]     Run the recorded steps again on the base (default) or the head
  After --, one argument is a shell command as written ('npm ci && npm run build'); several are an
  argv, quoted for you (sh -c 'a; b' works). Commands run as root with cwd /work/head by default.
  pr2video sandbox status | ls [--all] | down`

function describeStep(step: JournalEntry): string {
  if (step.kind === "copy") return `copy ${step.from} -> ${step.to}`
  if (step.kind === "exec") return `exec${step.data ? " data" : ""} ${step.cwd}$ ${step.command}`
  return `start ${step.name}${step.port ? ` :${step.port}` : ""} ${step.cwd}$ ${step.command}`
}

/** A run's record whether or not its sandbox is running: `run`, else the current one. */
async function storedRecord(cwd: string, run: string | undefined): Promise<SandboxRecord> {
  const { readRecord, currentRun, repoRoot } = await import("@pr2video/sandbox")
  const repo = await repoRoot(cwd)
  const chosen = run ?? (await currentRun(repo))
  if (!chosen) throw new Error("no sandbox yet: start one with `pr2video sandbox up`")
  return readRecord(repo, chosen)
}

/**
 * The command after `--`, as one shell string. One argument is taken as a
 * shell command as written (`exec -- 'npm ci && npm run build'`). Several are
 * an argv, each quoted, so `exec -- sh -c 'a; b'` runs exactly that.
 */
export function shellCommand(args: ReadonlyArray<string>): string {
  if (args.length === 1) return (args[0] ?? "").trim()
  return args.map(shellQuote).join(" ")
}

/** What the head is: a commit, or a copy of the working folder. */
function headLabel(record: SandboxRecord): string {
  return record.head.folder
    ? `head = the working folder as it was (${record.repo})`
    : `head ${record.head.sha.slice(0, 10)}`
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback * 1_000
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a number of seconds, got "${value}"`)
  return n * 1_000
}

function integer(value: string | undefined, what: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive whole number`)
  return n
}

/** Runs one sandbox command and answers its process exit code. */
export async function sandboxCommand(
  args: ReadonlyArray<string>,
  flags: SandboxFlags,
): Promise<number> {
  const [sub, ...rest] = args
  const json = flags.json === true
  const say = (line: string) => {
    if (!json) console.log(line)
  }
  const answer = (value: unknown) => {
    if (json) console.log(JSON.stringify(value, null, 2))
  }
  const cwd = process.cwd()

  switch (sub) {
    case "up": {
      const record = await up({
        cwd,
        run: flags.run,
        head: flags.head,
        base: flags["no-base"] ? null : flags.base,
        from: flags.from,
        folder: flags.folder,
        log: json ? undefined : say,
      })
      if (flags.from) {
        const restored = await restoredSteps(record)
        const result = await replay(record, {
          side: "head",
          restoredSteps: restored,
          onStep: json
            ? undefined
            : (step) =>
                say(`${step.ok ? "ok  " : "FAIL"} ${describeStep(step.entry)}: ${step.detail}`),
        })
        answer({ ok: result.ok, ...record, replay: result })
        if (!result.ok)
          say(
            "the setup did not replay on this head: fix the step, then `sandbox journal drop` and record it again",
          )
        return result.ok ? 0 : 1
      }
      answer({ ok: true, ...record })
      say(
        `sandbox ${record.container}: ${headLabel(record)} at ${record.head.dir}` +
          (record.base
            ? `, base ${record.base.sha.slice(0, 10)} (${record.base.ref}) at ${record.base.dir}`
            : ", no base"),
      )
      return 0
    }
    case "exec": {
      const command = shellCommand(rest)
      if (!command)
        throw new Error("usage: pr2video sandbox exec [--cwd dir] [--record] -- <command>")
      const record = await resolveRecord(cwd, flags.run)
      const result = await exec(record, command, {
        cwd: flags.cwd,
        record: flags.record || flags.data,
        data: flags.data,
        timeoutMs: seconds(flags.timeout, 20 * 60),
        onOutput: json ? undefined : (chunk) => process.stdout.write(chunk),
      })
      answer({ ok: result.exitCode === 0, ...result })
      if (!json && result.timedOut) console.error(`pr2video: timed out after ${result.ms}ms`)
      if (!json) {
        const steps = result.recorded ? (await readJournal(record.repo, record.run)).length : 0
        console.error(
          `pr2video: exit ${result.exitCode ?? "none"} in ${(result.ms / 1000).toFixed(1)}s` +
            (result.recorded
              ? `, recorded as step ${steps}`
              : flags.record || flags.data
                ? ", not recorded (it failed): fix it and run it again"
                : ""),
        )
      }
      return result.exitCode ?? 1
    }
    case "start": {
      const [name, ...command] = rest
      if (!name || !command.length)
        throw new Error("usage: pr2video sandbox start <name> [--port n] [--record] -- <command>")
      const record = await resolveRecord(cwd, flags.run)
      const port = flags.port ? integer(flags.port, "--port") : undefined
      const result = await start(record, name, shellCommand(command), {
        cwd: flags.cwd,
        port,
        path: flags.path,
        record: flags.record,
        timeoutMs: seconds(flags.timeout, 180),
      })
      const ok = result.wait ? result.wait.ok : true
      answer({ ok, name, ...result })
      say(`${name}: pid ${result.pid}${result.wait ? `, ${result.wait.status}` : ""}`)
      if (flags.record)
        say(
          result.recorded
            ? `recorded as step ${(await readJournal(record.repo, record.run)).length}`
            : "not recorded (nothing answered): fix it and start it again",
        )
      if (!ok) say(`see its output: pr2video sandbox logs ${name}`)
      return ok ? 0 : 1
    }
    case "wait": {
      const record = await resolveRecord(cwd, flags.run)
      const result = await waitPort(record, integer(rest[0], "the port"), {
        name: flags.name,
        path: flags.path,
        timeoutMs: seconds(flags.timeout, 180),
      })
      answer(result)
      say(result.status)
      return result.ok ? 0 : 1
    }
    case "cp": {
      const [from, to] = rest
      if (!from || !to) throw new Error("usage: pr2video sandbox cp <host path> <sandbox path>")
      const record = await resolveRecord(cwd, flags.run)
      await copyIn(record, from, to, { record: flags.record })
      answer({ ok: true, from, to, recorded: Boolean(flags.record) })
      say(`copied ${from} to ${to}${flags.record ? " (recorded)" : ""}`)
      return 0
    }
    case "save": {
      const record = await resolveRecord(cwd, flags.run)
      const paths = (flags.path ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
      const manifest = await saveData(record, paths, json ? undefined : say)
      answer({ ok: true, ...manifest })
      say(
        `saved ${(manifest.bytes / 1e6).toFixed(1)} MB after ${manifest.steps} steps; start a later run from it with: pr2video sandbox up --from ${record.run}`,
      )
      return 0
    }
    case "stop": {
      if (!rest[0]) throw new Error("usage: pr2video sandbox stop <name>")
      const record = await resolveRecord(cwd, flags.run)
      const stopped = await stop(record, rest[0])
      answer({ ok: true, stopped })
      say(stopped ? `stopped ${rest[0]}` : `${rest[0]} was not running`)
      return 0
    }
    case "ps": {
      const record = await resolveRecord(cwd, flags.run)
      const found = await processes(record)
      answer({ processes: found })
      for (const p of found)
        say(`${p.name.padEnd(16)} pid ${p.pid} ${p.running ? "running" : "exited"}`)
      if (!found.length) say("no background processes")
      return 0
    }
    case "logs": {
      if (!rest[0]) throw new Error("usage: pr2video sandbox logs <name> [--tail n]")
      const record = await resolveRecord(cwd, flags.run)
      const text = await logs(record, rest[0], flags.tail ? integer(flags.tail, "--tail") : 100)
      answer({ name: rest[0], log: text })
      if (!json) process.stdout.write(text)
      return 0
    }
    case "journal": {
      // The journal is a file on the host: reading or editing it needs no running sandbox.
      const record = await storedRecord(cwd, flags.run)
      if (rest[0] === "move") {
        const from = integer(rest[1], "the step")
        const to = integer(rest[2], "where it goes")
        const moved = await moveJournalStep(record.repo, record.run, from, to)
        answer({ ok: true, moved, from, to })
        say(`moved step ${from} to ${to}: ${describeStep(moved)}`)
        return 0
      }
      if (rest[0] === "drop") {
        // One step (`drop 3`) or a range (`drop 2-7`, to record a middle step again).
        const [first = "", last = first] = (rest[1] ?? "").split("-")
        const from = integer(first, "the step")
        const dropped = await dropJournalSteps(
          record.repo,
          record.run,
          from,
          integer(last, "the step"),
        )
        answer({ ok: true, dropped })
        for (const [i, step] of dropped.entries())
          say(`dropped step ${from + i}: ${describeStep(step)}`)
        return 0
      }
      const journal = await readJournal(record.repo, record.run)
      answer({ steps: journal })
      for (const [i, step] of journal.entries()) say(`${i + 1}. ${describeStep(step)}`)
      if (!journal.length) say("no recorded steps; add --record to exec and start")
      return 0
    }
    case "replay": {
      const record = await resolveRecord(cwd, flags.run)
      const side = flags.side ?? "base"
      if (side !== "head" && side !== "base") throw new Error("--side is head or base")
      const result = await replay(record, {
        side,
        onStep: json
          ? undefined
          : (step) =>
              say(`${step.ok ? "ok  " : "FAIL"} ${describeStep(step.entry)}: ${step.detail}`),
      })
      answer(result)
      return result.ok ? 0 : 1
    }
    case "status": {
      const record = await resolveRecord(cwd, flags.run)
      const found = await processes(record)
      answer({ ...record, processes: found })
      say(`${record.container} (run ${record.run}), image ${record.image}`)
      say(`${headLabel(record)} at ${record.head.dir}`)
      if (record.base)
        say(`base ${record.base.sha.slice(0, 10)} (${record.base.ref}) at ${record.base.dir}`)
      for (const p of found) say(`  ${p.name} pid ${p.pid} ${p.running ? "running" : "exited"}`)
      return 0
    }
    case "ls": {
      // This project's sandboxes; --all for every project's on this machine.
      const { repoRoot, runDir } = await import("@pr2video/sandbox")
      const repo = await repoRoot(cwd)
      const all = await list()
      const mine = await Promise.all(
        all.map((s) =>
          access(runDir(repo, s.run)).then(
            () => true,
            () => false,
          ),
        ),
      )
      const found = flags.all ? all : all.filter((_, i) => mine[i])
      answer({ sandboxes: found })
      if (!flags.all && found.length < all.length)
        say(`(${all.length - found.length} more from other projects: --all lists them)`)
      for (const s of found)
        say(`${s.run.padEnd(14)} ${s.state.padEnd(8)} ${s.container}  ${s.created}`)
      if (!found.length) say("no sandboxes")
      return 0
    }
    case "down": {
      const record = await resolveRecord(cwd, flags.run).catch(async (error: Error) => {
        // A stopped sandbox is still worth removing.
        const { readRecord, currentRun } = await import("@pr2video/sandbox")
        const { repoRoot } = await import("@pr2video/sandbox")
        const repo = await repoRoot(cwd)
        const run = flags.run ?? (await currentRun(repo))
        if (!run) throw error
        return readRecord(repo, run)
      })
      await down(record)
      answer({ ok: true, removed: record.container })
      say(`removed ${record.container} (its journal and logs stay in .pr2video/${record.run}/)`)
      say(
        "pr2video-mirror, the Docker Hub pull cache every sandbox shares, keeps running for the next run (a few MB of memory); `docker rm -f pr2video-mirror` removes it, and the next `sandbox up` starts it again",
      )
      return 0
    }
    default:
      throw new Error(`unknown sandbox command "${sub ?? ""}"; run pr2video --help`)
  }
}
