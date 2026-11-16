import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

async function pr2video(...args: Array<string>): Promise<{ code: number; json: unknown }> {
  try {
    const { stdout } = await promisify(execFile)("node", ["--conditions=development", cli, ...args])
    return { code: 0, json: JSON.parse(stdout) }
  } catch (error) {
    const failed = error as { code: number; stdout: string }
    return { code: failed.code, json: JSON.parse(failed.stdout) }
  }
}

describe("pr2video", () => {
  it("lists every voice, and none is always ready", async () => {
    const { code, json } = await pr2video("voices", "--json")
    expect(code).toBe(0)
    const voices = (json as { voices: Array<{ id: string; ok: boolean }> }).voices
    expect(voices.map((v) => v.id)).toEqual(["kokoro", "say", "piper", "espeak", "none"])
    expect(voices.find((v) => v.id === "none")?.ok).toBe(true)
  })

  it("checks a tour and exits 1 with its problems", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr2video-cli-"))
    const path = join(dir, "tour.json")
    await writeFile(path, JSON.stringify({ version: 1, title: "T", summary: "", scenes: [] }))
    const { code, json } = await pr2video("tour", "check", path, "--json")
    expect(code).toBe(1)
    expect(json).toMatchObject({ ok: false, problems: [{ path: "scenes" }] })
  })
})
