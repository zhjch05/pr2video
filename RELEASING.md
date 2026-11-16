# Releasing

Nothing here has been published yet. Before the first release:

1. **Repository.** `github.com/zhjch05/pr2video`, already named in every package's `repository`,
   `homepage` and `bugs`, in the plugin manifest and in `README.md`. Create it public and push `main`.
2. **npm.** `pr2video` and the `@pr2video` scope were free on 2026-11-16. Create the `@pr2video`
   organization on npm (the packages publish with `access: public`).
3. **License.** MIT was chosen as a default; confirm it.
4. **Check.** `pnpm install && pnpm lint && pnpm check-types && pnpm build && pnpm test`, plus
   `PR2VIDEO_TEST_DOCKER=1` and `PR2VIDEO_TEST_MP4=1` runs locally (CI runs neither).

## Each release

1. Set the same version in every `packages/*/package.json` and `plugin/.claude-plugin/plugin.json`.
2. `pnpm build`, then try the packed packages the way a user installs them:

   ```bash
   for d in tour voice player sandbox recorder cli; do (cd packages/$d && pnpm pack --pack-destination /tmp/p2v); done
   npm install -g --prefix /tmp/p2v-global /tmp/p2v/*.tgz playwright
   PATH=/tmp/p2v-global/bin:$PATH pr2video voices
   ```

3. Publish in dependency order with `pnpm publish` (it rewrites `workspace:*` and `catalog:` to
   real versions): tour, voice, player, sandbox, recorder, then pr2video.
4. Tag `v<version>` and push the tag; the plugin installs from the repository.

## What the packages ship

`dist` only: each package's `pr2video-source` export condition points at `src`, which is for this
workspace (tests, `pnpm pr2video`). `@pr2video/sandbox` also ships `image/` (the sandbox's
Dockerfile, built on first use), `@pr2video/recorder` its bundled `record.mjs`, and
`@pr2video/player` its browser bundle.
