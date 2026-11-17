import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  parseEnvFile,
  readSecrets,
  refuseValues,
  scrub,
  secretsIn,
  secretsPath,
  shellEnv,
  writeSecrets,
} from "../src/secrets.ts"

describe("secrets", () => {
  it("parses a .env file", () => {
    expect(
      parseEnvFile(
        [
          "# a comment",
          "export STRIPE_KEY=sk_test_123 # inline",
          'QUOTED="a b \\"c\\""',
          "SINGLE='x=y'",
          "EMPTY=",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({ STRIPE_KEY: "sk_test_123", QUOTED: 'a b "c"', SINGLE: "x=y", EMPTY: "" })
  })

  it("stores values readable only by the user, and reads them back", async () => {
    const repo = await mkdtemp(join(tmpdir(), "p2v-secrets-"))
    const value = 'line one\nit\'s "quoted" $HOME'
    await writeSecrets(repo, { B_KEY: "bbbb", A_KEY: value })
    expect(await readSecrets(repo)).toEqual({ A_KEY: value, B_KEY: "bbbb" })
    expect((await stat(secretsPath(repo))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(repo, ".pr2video", ".gitignore"), "utf8")).toBe("*\n")
  })

  it("scrubs values from output, longest first, and leaves short ones", () => {
    const secrets = { LONG: "abcdef123", PART: "abcd", TINY: "1" }
    expect(scrub("key=abcdef123 and abcd and 1", secrets)).toBe("key=*** and *** and 1")
    expect(secretsIn("uses abcd", secrets)).toEqual(["PART"])
  })

  it("refuses a command that holds a value", () => {
    expect(() => refuseValues("curl -H 'Bearer abcdef123'", { TOKEN: "abcdef123" })).toThrow(
      /\$TOKEN/,
    )
    expect(() => refuseValues('curl -H "Bearer $TOKEN"', { TOKEN: "abcdef123" })).not.toThrow()
  })

  it("quotes values for the shell", () => {
    expect(shellEnv({ A: "it's $x" })).toBe("export A='it'\\''s $x'")
  })
})
