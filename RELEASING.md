# Releasing

Nothing here has been published yet. Before the first release:

1. **Repository.** `github.com/zhjch05/pr2video`, already named in `packages/cli/package.json` (`repository`,
   `homepage`, `bugs`), in `.claude-plugin/plugin.json` and in `README.md`. Create it public and push `main`.
2. **npm.** `pr2video` was free on 2026-11-16. It is the only package published (the `@pr2video/*`
   packages are bundled into it and stay private), so no npm organization is needed.
3. **License.** MIT was chosen as a default; confirm it.
4. **Check.** `PR2VIDEO_TEST_DOCKER=1` and `PR2VIDEO_TEST_MP4=1 pnpm test` locally before a
   release: CI and the release workflow run neither.

## First release (once)

npm only lets you set up trusted publishing on a package that already exists, so 0.0.1 goes up by hand:

1. Create the repository and push `main`.
2. Publish 0.0.1 from your machine (`npm login` first):

   ```bash
   pnpm install && pnpm build
   (cd packages/cli && pnpm pack --pack-destination /tmp/p2v)
   npm publish /tmp/p2v/pr2video-0.0.1.tgz --access public
   ```

3. On npmjs.com, open pr2video → Settings → Trusted Publisher, choose GitHub Actions and enter
   owner `zhjch05`, repository `pr2video`, workflow `release.yml`, environment `npm`.
4. Same page, Publishing access: "Require two-factor authentication and disallow tokens", so only
   the workflow (and you, with 2FA) can publish.
5. Optional: on GitHub, Settings → Environments → `npm` (made by the first workflow run, or create
   it), add yourself as a required reviewer, so every publish waits for your click.
6. Tag the hand-published version so the history matches npm: `git tag v0.0.1 && git push origin v0.0.1`.
   The workflow runs, fails at `npm publish` (0.0.1 already exists) and makes no GitHub release; that
   one failure is expected. Or skip this tag.

## Each release

1. `node scripts/version.ts <version>` (the CLI, the plugin manifest and the skill), and commit it on
   `main`.
2. Optionally try the packed package the way a user installs it:

   ```bash
   pnpm build && (cd packages/cli && pnpm pack --pack-destination /tmp/p2v)
   npm install -g --prefix /tmp/p2v-global /tmp/p2v/pr2video-*.tgz playwright
   PATH=/tmp/p2v-global/bin:$PATH pr2video voices
   ```

3. `git tag v<version> && git push origin main v<version>`. `.github/workflows/release.yml` checks
   the tag matches every version, runs lint, types, build and tests, publishes to npm with
   provenance, and makes a GitHub release with generated notes and the tarball. A tag with a hyphen
   (`v0.2.0-beta.1`) publishes under npm's `next` tag and as a pre-release.
4. Claude Code's plugin and `npx skills add` take the skill from `main`, so the skill pins the
   version it is written for and runs `npx -y pr2video@<version>` when the installed CLI differs.
   Bump the version together with the release: a skill on `main` that names an unpublished version
   breaks until the tag is published. `pr2video skill install` copies the skill shipped in the
   package, so it always matches.

## What the package ships

`dist/cli.js` (every workspace package and zod bundled in), `dist/assets/` (the player's script and
styles, the recorder's `record.mjs`), `image/` (the sandbox's Dockerfile, built on first use) and the
repository's README. The build copies `image/` and the README into `packages/cli/`; both are ignored
by git.
