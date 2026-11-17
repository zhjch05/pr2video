# CLAUDE.md

pr2video turns a pull request into a narrated tour of the running app. Read `docs/design.md` first.

## Rules

- **The CLI makes no model calls.** Thinking belongs to the user's agent through the skill in
  `skills/pr2video/`. A new judgment call becomes skill text plus a `check` command, not a
  prompt inside the CLI.
- **Everything the agent writes has a `check`** that names each problem by path, worded so the agent
  can fix it. Exit 1 when there are problems.
- **Every command answers `--json`** with a stable shape; human output is for people only.
- **`@pr2video/tour` stays pure** (no I/O): the player and the MP4 renderer must draw the same frames.
- **Nothing in the player animates on the wall clock** (no CSS transitions on the stage, no timers
  deciding what is shown): the renderer steps time itself. Anything that moves is a function of the
  tour time, in `packages/player/src/frame.ts`.
- **A `page.evaluate` callback runs in the browser**: it can use nothing from the Node module around it.
- The player's bundle (`dist/bundle/`) must be built before `render`; `pnpm test` builds it first.
  `PR2VIDEO_TEST_MP4=1 pnpm test` also renders a real MP4 (needs ffmpeg and Chromium).
- **The project's code runs only in the sandbox.** No CLI command runs project code on the
  host. The image's tag is a hash of `packages/sandbox/image/`, so editing it builds a new image.
  `PR2VIDEO_TEST_DOCKER=1 pnpm test` runs a real sandbox end to end.
- **Voices are free and local.** No voice may need an account or a key. `kokoro-js` is an optional
  peer, loaded with a dynamic import, so the CLI installs light.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): the CLI runs from source with
  `node --conditions=pr2video-source`, which only strips types.
- **The skill is agent-neutral.** `skills/pr2video/` follows the Agent Skills format (name,
  description, license, compatibility, `metadata.version`) and names no agent's tools; anything
  Claude Code-only goes in `commands/` or `.claude-plugin/`. The repository root is the Claude Code
  plugin (`.claude-plugin/marketplace.json` → `"./"`), and the same `skills/` folder is what
  `npx skills add` and `pr2video skill install` copy.
- **One version, four places**: `packages/cli/package.json`, `.claude-plugin/plugin.json` and the
  skill's metadata and pinned `npx -y pr2video@<version>`. Change them with
  `node scripts/version.ts <version>`; CI and the release workflow run `--check`.
- **Only `pr2video` is published.** The `@pr2video/*` packages are private to this workspace: the
  CLI's build (`packages/cli/scripts/bundle.ts`) bundles them and zod into one `dist/cli.js` and
  copies in what they build for run time (`dist/assets/`: the player bundle and `record.mjs`; `image/`:
  the sandbox image) and the skill (`skills/`). The CLI reads those through `src/assets.ts`, never by resolving a package, so
  the published CLI depends only on Playwright (for MP4 and stills; `pr2video browser install` gets
  its Chromium) and the optional peer kokoro-js.
- Workspace packages export `pr2video-source` → `src` first (a condition of our own: bundlers
  resolve `development`), so tests, the dev CLI and the CLI's bundle use the source.

## Before calling something done

```bash
pnpm check-types && pnpm lint && pnpm test && pnpm build
```
