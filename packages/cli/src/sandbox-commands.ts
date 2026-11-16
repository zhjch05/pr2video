/**
 * `pr2video sandbox ...`: the sandbox an agent sets the pull request up in.
 * Human output streams; `--json` answers one object per command.
 */
import {
  down,
  exec,
  list,
  logs,
  processes,
  readJournal,
  replay,
  resolveRecord,
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
}

export const SANDBOX_HELP = `Sandbox (one Docker container per run; the pull request never runs on your machine):
  pr2video sandbox up [--head <ref>] [--base <ref> | --no-base] [--run <id>]
                                                Check out head (/work/head) and base (/work/base) in a new sandbox
  pr2video sandbox exec [--cwd <dir>] [--record] [--timeout <s>] -- <command>
                                                Run a command inside; --record adds it to the setup journal
  pr2video sandbox start <name> [--port <n>] [--cwd <dir>] [--record] -- <command>
                                                Start a background process (a server); --port waits until it answers
  pr2video sandbox wait <port> [--name <process>] [--timeout <s>]
  pr2video sandbox ps | logs <name> [--tail <n>] | stop <name>
  pr2video sandbox journal                      The recorded setup steps
  pr2video sandbox replay                       Run the recorded steps again on the base commit
  pr2video sandbox status | ls | down`

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
        log: json ? undefined : say,
      })
      answer({ ok: true, ...record })
      say(
        `sandbox ${record.container}: head ${record.head.sha.slice(0, 10)} at ${record.head.dir}` +
          (record.base
            ? `, base ${record.base.sha.slice(0, 10)} (${record.base.ref}) at ${record.base.dir}`
            : ", no base"),
      )
      return 0
    }
    case "exec": {
      const command = rest.join(" ").trim()
      if (!command)
        throw new Error("usage: pr2video sandbox exec [--cwd dir] [--record] -- <command>")
      const record = await resolveRecord(cwd, flags.run)
      const result = await exec(record, command, {
        cwd: flags.cwd,
        record: flags.record,
        timeoutMs: seconds(flags.timeout, 20 * 60),
        onOutput: json ? undefined : (chunk) => process.stdout.write(chunk),
      })
      answer({ ok: result.exitCode === 0, ...result })
      if (!json && result.timedOut) console.error(`pr2video: timed out after ${result.ms}ms`)
      return result.exitCode ?? 1
    }
    case "start": {
      const [name, ...command] = rest
      if (!name || !command.length)
        throw new Error("usage: pr2video sandbox start <name> [--port n] [--record] -- <command>")
      const record = await resolveRecord(cwd, flags.run)
      const port = flags.port ? integer(flags.port, "--port") : undefined
      const result = await start(record, name, command.join(" "), {
        cwd: flags.cwd,
        port,
        record: flags.record,
        timeoutMs: seconds(flags.timeout, 180),
      })
      const ok = result.wait ? result.wait.ok : true
      answer({ ok, name, ...result })
      say(`${name}: pid ${result.pid}${result.wait ? `, ${result.wait.status}` : ""}`)
      if (!ok) say(`see its output: pr2video sandbox logs ${name}`)
      return ok ? 0 : 1
    }
    case "wait": {
      const record = await resolveRecord(cwd, flags.run)
      const result = await waitPort(record, integer(rest[0], "the port"), {
        name: flags.name,
        timeoutMs: seconds(flags.timeout, 180),
      })
      answer(result)
      say(result.status)
      return result.ok ? 0 : 1
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
      const record = await resolveRecord(cwd, flags.run)
      const journal = await readJournal(record.repo, record.run)
      answer({ steps: journal })
      for (const [i, step] of journal.entries())
        say(
          step.kind === "exec"
            ? `${i + 1}. exec (exit ${step.exitCode}) ${step.cwd}$ ${step.command}`
            : `${i + 1}. start ${step.name}${step.port ? ` :${step.port}` : ""} ${step.cwd}$ ${step.command}`,
        )
      if (!journal.length) say("no recorded steps; add --record to exec and start")
      return 0
    }
    case "replay": {
      const record = await resolveRecord(cwd, flags.run)
      const result = await replay(record, {
        onStep: json
          ? undefined
          : (step) =>
              say(
                `${step.ok ? "ok  " : "FAIL"} ${step.entry.kind} ${step.entry.kind === "start" ? step.entry.name : step.entry.command}: ${step.detail}`,
              ),
      })
      answer(result)
      return result.ok ? 0 : 1
    }
    case "status": {
      const record = await resolveRecord(cwd, flags.run)
      const found = await processes(record)
      answer({ ...record, processes: found })
      say(`${record.container} (run ${record.run}), image ${record.image}`)
      say(`head ${record.head.sha.slice(0, 10)} at ${record.head.dir}`)
      if (record.base)
        say(`base ${record.base.sha.slice(0, 10)} (${record.base.ref}) at ${record.base.dir}`)
      for (const p of found) say(`  ${p.name} pid ${p.pid} ${p.running ? "running" : "exited"}`)
      return 0
    }
    case "ls": {
      const found = await list()
      answer({ sandboxes: found })
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
      return 0
    }
    default:
      throw new Error(`unknown sandbox command "${sub ?? ""}"; run pr2video --help`)
  }
}
