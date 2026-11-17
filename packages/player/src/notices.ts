/**
 * The third-party code pr2video ships inside its own files, with each
 * copyright line. These are MIT (the permission notice is `MIT_LICENSE`);
 * `ISC_NOTICES` are the ISC ones (`ISC_LICENSE`).
 * `THIRD_PARTY_NOTICES.md` at the repository root says the same for people;
 * a test keeps the two in step.
 */
export const NOTICES: ReadonlyArray<{ name: string; copyright: string; in: string }> = [
  {
    name: "rrweb (with rrweb-snapshot, rrdom and @rrweb/utils)",
    copyright:
      "Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors)",
    in: "the tour player",
  },
  {
    name: "@xstate/fsm (inside rrweb)",
    copyright: "Copyright (c) 2015 David Khourshid",
    in: "the tour player",
  },
  {
    name: "mitt (inside rrweb)",
    copyright: "Copyright (c) 2021 Jason Miller",
    in: "the tour player",
  },
  {
    name: "base64-arraybuffer (inside rrweb)",
    copyright: "Copyright (c) 2012 Niklas von Hertzen",
    in: "the tour player",
  },
  {
    name: "zod",
    copyright: "Copyright (c) 2025 Colin McDonnell",
    in: "the CLI, the recorder and the tour player",
  },
  {
    name: "Feather icons (maximize, minimize; through Lucide)",
    copyright: "Copyright (c) 2013-present Cole Bemis",
    in: "the tour player's controls",
  },
]

/** Under the ISC licence (`ISC_LICENSE`). */
export const ISC_NOTICES: ReadonlyArray<{ name: string; copyright: string; in: string }> = [
  {
    name: "Lucide icons",
    copyright: "Copyright (c) 2026 Lucide Icons and Contributors",
    in: "the tour player's controls",
  },
]

export const ISC_LICENSE = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

export const MIT_LICENSE = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/** The licence comment at the top of the player script, which every tour page carries. */
export function playerNotice(): string {
  const lines = [
    "pr2video tour player - Copyright (c) 2026 James Zhang - MIT License",
    "https://github.com/zhjch05/pr2video",
    "",
    "It includes the following, each under the MIT License below:",
    ...NOTICES.map((n) => `- ${n.name}: ${n.copyright}`),
    "",
    MIT_LICENSE,
    "",
    "And the following, each under the ISC License below:",
    ...ISC_NOTICES.map((n) => `- ${n.name}: ${n.copyright}`),
    "",
    ISC_LICENSE,
  ]
  return `/*!\n${lines.map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */`
}
