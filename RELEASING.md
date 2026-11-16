# Releasing

Nothing here has been published yet. Before the first release:

1. **Repository.** `github.com/zhjch05/pr2video`, already named in `packages/cli/package.json` (`repository`,
   `homepage`, `bugs`), in the plugin manifest and in `README.md`. Create it public and push `main`.
2. **npm.** `pr2video` was free on 2026-11-16. It is the only package published (the `@pr2video/*`
   packages are bundled into it and stay private), so no npm organization is needed.
3. **License.** MIT was chosen as a default; confirm it.
4. **Check.** `pnpm install && pnpm lint && pnpm check-types && pnpm build && pnpm test`, plus
   `PR2VIDEO_TEST_DOCKER=1` and `PR2VIDEO_TEST_MP4=1` runs locally (CI runs neither).

## Each release

1. Set the same version in `packages/cli/package.json` and `plugin/.claude-plugin/plugin.json`.
2. `pnpm build`, then try the packed package the way a user installs it:

   ```bash
   (cd packages/cli && pnpm pack --pack-destination /tmp/p2v)
   npm install -g --prefix /tmp/p2v-global /tmp/p2v/pr2video-*.tgz playwright
   PATH=/tmp/p2v-global/bin:$PATH pr2video voices
   ```

3. `cd packages/cli && pnpm publish` (it rewrites `catalog:` and `workspace:*` in the published
   manifest; both appear only in `devDependencies`).
4. Tag `v<version>` and push the tag; the plugin installs from the repository.

## What the package ships

`dist/cli.js` (every workspace package and zod bundled in), `dist/assets/` (the player's script and
styles, the recorder's `record.mjs`), `image/` (the sandbox's Dockerfile, built on first use) and the
repository's README. The build copies `image/` and the README into `packages/cli/`; both are ignored
by git.
