# CLAUDE.md

pr2video turns a pull request into a narrated tour of the running app. Read `docs/design.md` first.

## Rules

- **The CLI makes no model calls.** Thinking belongs to the user's agent through the skill in
  `plugin/skills/pr2video/`. A new judgment call becomes skill text plus a `check` command, not a
  prompt inside the CLI.
- **Everything the agent writes has a `check`** that names each problem by path, worded so the agent
  can fix it. Exit 1 when there are problems.
- **Every command answers `--json`** with a stable shape; human output is for people only.
- **`@pr2video/tour` stays pure** (no I/O): the player and the MP4 renderer must draw the same frames.
- **Voices are free and local.** No voice may need an account or a key. `kokoro-js` is an optional
  peer, loaded with a dynamic import, so the CLI installs light.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): the CLI runs from source with
  `node --conditions=development`, which only strips types.
- Workspace packages export `development` → `src` first, so tests and the dev CLI use the source;
  the published build uses `dist`.

## Before calling something done

```bash
pnpm check-types && pnpm lint && pnpm test && pnpm build
```
