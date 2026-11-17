# pr2video

Make a narrated video tour of your web app from its project folder: a replay of the real UI with
zoom, highlights, captions and a voice, as a self-contained HTML file or an MP4. Tour what a pull
request, a branch or your uncommitted work changed (with "before" scenes from the base), or just the
app itself: a feature, a flow, an onboarding demo. No pull request and no git required.

pr2video is an **agent skill plus a CLI**. It works in Claude Code (as a plugin with a `/pr2video`
command) and in any coding agent that reads `SKILL.md` skills. Your agent, on your own tokens, does the thinking: it
reads the change or the code, gets the app running, picks the screens and writes what to say. The CLI does
everything that has to come out the same every time: the sandbox, the recording, validation, the
voice and the video. No account and no API key: every voice is free and runs on your machine.

> **Status: early.** Every stage works end to end (sandbox, recording, tour, narration, HTML and MP4).
> An agent with only the skill has made tours of three real open-source pull requests (a Vue app on
> phone widths, a Next.js app with Postgres, a Go + React app with before/after dialogs). See
> [docs/design.md](docs/design.md).

## Requirements

**Needed**

- **Node.js 24 or newer** (with npm and npx).
- **Docker, running**: Docker Desktop on macOS or Windows, Docker Engine on Linux. Every run starts
  one container, and your project is installed, built and served inside it, never on your machine.
  The container runs its own Docker engine (for the project's databases and services), so it must
  be allowed to run **privileged**; rootless Docker and Podman are untested. The first run builds a
  sandbox image of about 2.5 GB (a few minutes); later runs reuse it.
- **A coding agent** that runs shell commands: Claude Code (plugin), or Codex, Cursor, Gemini CLI
  and the others that read `SKILL.md` skills. It uses your own model account; pr2video makes no
  model calls.
- **Internet access** while setting up: the image build and your project's own dependencies.
- **git**, only for tours of a change (a pull request, a branch, a commit range). A tour of a
  folder as it is needs no git at all.

**Optional**

| For | Install |
|---|---|
| A natural voice | macOS `say` needs nothing; else `npm i -g kokoro-js` (90 MB model, once), Piper or eSpeak. Or no voice: captions only |
| MP4 export | `ffmpeg` on PATH, and once `pr2video browser install` (the Chromium build it draws with) |
| Still frames (`render --frame`) | that Chromium, as above |
| MP3 narration | `ffmpeg`; without it, narration is WAV |
| Reading GitHub pull requests | the `gh` CLI; without it the agent uses `git diff` |

**Not needed**: no pr2video account, API key or cloud service. The HTML tour is one file that opens
in any browser; images it loads from other sites show only while the viewer is online.

**Tested on** macOS with Docker Desktop. CI runs the unit tests on Linux, not yet the Docker sandbox
or MP4 export; Linux should work (Docker runs there natively) and Windows is untested.

## Install

The CLI:

```bash
npm install -g pr2video
npm install -g kokoro-js                                  # optional: the most natural free voice
pr2video browser install                                  # once, for MP4 and stills (plus ffmpeg on PATH)
```

Then the skill, for your agent:

**Claude Code**: the plugin (skill + `/pr2video` command):

```text
/plugin marketplace add zhjch05/pr2video
/plugin install pr2video@pr2video
```

Then: `/pr2video https://github.com/acme/shop/pull/12`, or `/pr2video the checkout flow`.

**Other agents** (Codex, Cursor, OpenCode and the others that read `SKILL.md` skills): the
[`skills`](https://github.com/vercel-labs/skills) installer knows where each agent looks:

```bash
npx skills add zhjch05/pr2video
```

Or copy the skill that matches your installed CLI into any skills folder your agent reads:

```bash
pr2video skill install .agents/skills      # makes .agents/skills/pr2video/
```

For an agent without skills, point it at `skills/pr2video/SKILL.md` and ask it to follow it. Then ask
your agent to "make a pr2video tour of this pull request" (or "of the settings page").

The skill names the CLI version it was written for, and runs `npx -y pr2video@<that version>` when
the installed CLI differs, so the two never disagree on commands or flags.

## Voices

All free and local. `--voice auto` (the default) picks the best one available.

| Voice | Quality | Needs |
|---|---|---|
| `kokoro` | Natural (Kokoro-82M, Apache-2.0) | `npm i -g kokoro-js`; ~90 MB model downloaded on first use to `~/.cache/pr2video` |
| `say` | Good | macOS only, nothing to install |
| `piper` | Natural | `pipx install piper-tts` and a voice model (`--model` or `PIPER_MODEL`) |
| `espeak` | Robotic | `brew install espeak-ng` / `apt install espeak-ng` |
| `none` | - | Captions only; each scene holds for reading time |

Narration is written as MP3 when `ffmpeg` is on your PATH, otherwise WAV.

## CLI

```text
pr2video voices [--json]                      List the free voices and whether each works here
pr2video speak <text> -o <path> [voice opts]  Speak one line
pr2video narrate <tour.json> [voice opts]     Narrate every scene of a tour
pr2video tour check <tour.json> [--json]      Validate a tour file
pr2video tour timeline <tour.json> [--vtt <out.vtt>] [--json]
pr2video render <tour.json> [--html <out.html>] [--mp4 <out.mp4>] [--fps 30] [--height 1080]
pr2video import <tour.html> -o <dir>          Import a tour downloaded from better-review
pr2video skill install <skills folder>        Copy the agent skill for this version
pr2video --version

pr2video sandbox up [--head <ref>] [--base <ref>]   One container per run: head + base checked out
pr2video sandbox up --folder [--base <ref>]          Or: the folder as it is (no git needed)
pr2video sandbox exec [--record] -- <command>        Run inside the sandbox
pr2video sandbox start <name> --port <n> -- <cmd>    Start a server and wait until it answers
pr2video sandbox replay                              Re-run the recorded setup on the base commit
pr2video sandbox save [--path <dir>]                 Keep the services' data for the next run
pr2video sandbox up --from <run>                     Start from an earlier run's setup and data
pr2video sandbox cp [--record] <host> <sandbox>     Copy a file in (journaled with --record)
pr2video sandbox ps | logs | stop | journal [drop <n>] | status | ls | down

pr2video scenes check [<scenes.json>]                Validate the scenes to film
pr2video record [--side head|base] [--only <id,id>]  Record them in the sandbox's browser (rrweb)
pr2video tour draft [--compare] [--fresh]            A tour.json from the recordings; keeps your captions
```

## The sandbox

Your project's code never runs on your machine. Each run gets one Docker container (`--privileged`,
needed for Docker-in-Docker) with the head at `/work/head` (a commit, or with `--folder` a copy of
the folder as it is, uncommitted files included) and the base, when there is one, at `/work/base`, its own
Docker engine for the project's services (`docker compose` works inside), Node 24, Python and
Chromium. A local registry mirror caches Docker Hub pulls, and pnpm/npm caches persist across runs.
The image (about 2.5 GB) builds on first use.

## Output

- **HTML**: one file with the player, every recording (gzipped) and the narration inline. It opens
  from disk with no network: play, pause, seek, speed, mute, captions, and a list of scenes.
- **MP4**: H.264 + AAC, rendered frame by frame from the same page in headless Chromium, so it
  matches the HTML tour exactly. Several pages draw frames at once (`--workers`, default half the
  cores, at most 6): a 2-minute tour at 30 fps takes about 40 seconds on a 10-core laptop.

## Development

```bash
pnpm install
pnpm check-types && pnpm lint && pnpm test && pnpm build
pnpm pr2video --help        # runs the CLI from source
```

## License

MIT
