import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { ISC_NOTICES, NOTICES, playerNotice } from "../src/notices.ts"

const root = new URL("../../../", import.meta.url)

describe("third-party notices", () => {
  it("THIRD_PARTY_NOTICES.md names every bundled package and its copyright", async () => {
    const md = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8")
    for (const notice of [...NOTICES, ...ISC_NOTICES]) {
      expect(md).toContain(notice.name)
      expect(md).toContain(notice.copyright)
    }
    expect(md).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(md).toContain("## ISC License")
  })

  it("the built player script, which every tour page inlines, opens with the notice", async () => {
    const script = await readFile(new URL("packages/player/dist/bundle/player.js", root), "utf8")
    expect(script.startsWith(playerNotice())).toBe(true)
  })
})
