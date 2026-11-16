/** Child processes for the voices that are command-line programs, and for ffmpeg. */
import { spawn } from "node:child_process"

export type RunResult = { code: number | null; stdout: string; stderr: string }

/** Runs `command` with `args` (no shell), writing `stdin` to it when given. Never throws on a non-zero exit. */
export function run(
  command: string,
  args: ReadonlyArray<string>,
  stdin?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? "")
  })
}

/** Whether `command` is on PATH. */
export async function onPath(command: string): Promise<boolean> {
  try {
    const result = await run(process.platform === "win32" ? "where" : "which", [command])
    return result.code === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

/** Runs and throws with the command's own words when it fails. */
export async function runOrThrow(
  command: string,
  args: ReadonlyArray<string>,
  stdin?: string,
): Promise<RunResult> {
  const result = await run(command, args, stdin)
  if (result.code !== 0)
    throw new Error(
      `${command} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
  return result
}
