/** The host's `docker` CLI, without a shell. */
import { spawn } from "node:child_process"

export type DockerResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type DockerOptions = {
  /** Kill the command after this long. */
  timeoutMs?: number | undefined
  /** Each chunk of output as it arrives (stdout and stderr both). */
  onOutput?: ((chunk: string) => void) | undefined
  stdin?: string | undefined
}

export function docker(
  args: ReadonlyArray<string>,
  options: DockerOptions = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, options.timeoutMs)
      : null
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stdout += text
      options.onOutput?.(text)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stderr += text
      options.onOutput?.(text)
    })
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("docker is not installed or not on PATH")
          : error,
      )
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.end(options.stdin ?? "")
  })
}

/** Runs docker and throws with its own words when it fails. */
export async function dockerOrThrow(
  args: ReadonlyArray<string>,
  options: DockerOptions = {},
): Promise<string> {
  const result = await docker(args, options)
  if (result.code !== 0)
    throw new Error(
      `docker ${args[0]} failed${result.timedOut ? " (timed out)" : ""}: ${(result.stderr || result.stdout).trim().slice(-2_000)}`,
    )
  return result.stdout
}

/** Whether the Docker daemon answers. */
export async function dockerReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 })
    return result.code === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `the Docker daemon is not running: ${result.stderr.trim().split("\n")[0]}`,
        }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
