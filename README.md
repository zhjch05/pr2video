# pr2video

Show what your web app actually does, by running it and using it the way a person would, then
recording that as a narrated tour: a replay of the real UI with zoom, highlights, captions and a
voice, as a self-contained HTML file or an MP4. Tour what a pull request, a branch or your uncommitted
work changed (with "before" scenes from the base), or just the app itself: a feature, a flow, an
onboarding demo. No pull request and no git required.

## What this is, and is not

**pr2video is not a general video maker.** A capable coding model can already script a slideshow,
an animation or a mock-up of an app on its own. That video shows what the model *thinks* the app
does. pr2video's video shows what the app *did*, because it is a recording of the app running.

The hard part is not the video; it is **the environment**. To film a real flow, pr2video:

1. **Reproduces the app** from its source in a throwaway sandbox: installs dependencies, starts its
   databases and services, builds and serves it, and seeds the data the flow needs (users, records,
   a signed-in session). The agent works out how, and every setup step is journaled so the same
   environment can be rebuilt for the base commit or the next run.
2. **Drives it like a person would test it**, in a real browser: the clicks, typing and waits of a
   human test flow, stopping at checkpoints, with the screenshot and the elements on screen recorded
   at each one.
3. **Shows what happened**: the replay is the recorded page itself, the highlights are the elements
   measured at each checkpoint, and the agent writes each caption from that checkpoint's screenshot.
   A step that fails, or a screen the app never reached, is reported, not drawn.

The tour is the evidence of that run: the change, or the feature, working in the real app.

## Scope

**Today: web apps with a browser UI.** Anything that serves pages a browser can open, from a static
site to a full-stack app with its database and services (`docker compose` works inside the sandbox),
as long as it builds and runs in a Linux container.

**Not yet:**

- Changes with no screen of their own: a CLI or terminal tool, a database migration, an API with no
  page that shows its result, a library.
- Desktop, mobile and other non-web apps.

We may add these later: dedicated skills for terminal sessions, database changes and API changes,
each with its own way to show the result, and general computer use to record non-web apps. Until
then, for a change with no UI the skill says so: it stops, or, when only a screen elsewhere shows
the result, asks you before filming that.

## How it works

pr2video is an **agent skill plus a CLI**. It works in Claude Code (as a plugin with a `/pr2video`
command) and in any coding agent that reads `SKILL.md` skills. Your agent, on your own tokens, does the thinking: it
reads the change or the code, gets the app running, picks the screens and writes what to say. The CLI does
everything that has to come out the same every time: the sandbox, the recording, validation, the
voice and the video. No account and no API key: every voice is free and runs on your machine.

> **Status: early.** Every stage works end to end (sandbox, recording, tour, narration, HTML and MP4).
> An agent with only the skill has made tours of three real open-source pull requests (a Vue app on
> phone widths, a Next.js app with Postgres, a Go + React app with before/after dialogs) and of one
> app with no pull request at all (it-tools, from a plain folder). See
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
| A natural voice | macOS `say` needs nothing (personal, non-commercial use only); else `npm i -g kokoro-js` (90 MB model, once), Piper or eSpeak. Or no voice: captions only |
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

| Voice | Quality | Needs | Sharing the audio |
|---|---|---|---|
| `kokoro` | Natural (Kokoro-82M, Apache-2.0) | `npm i -g kokoro-js`; ~90 MB model downloaded on first use to `~/.cache/pr2video` | Free to share, commercially too |
| `say` | Good | macOS only, nothing to install | **Personal, non-commercial use only** (Apple's licence) |
| `piper` | Natural | `pipx install piper-tts` and a voice model (`--model` or `PIPER_MODEL`) | Depends on the voice model |
| `espeak` | Robotic | `brew install espeak-ng` / `apt install espeak-ng` | Free to share |
| `none` | - | Captions only; each scene holds for reading time | - |

For a tour you will publish or share, use `kokoro` (or no voice): `--voice auto` picks `say` on a
Mac without kokoro, and `narrate` then prints a note saying so. See [Licences](#licences).

Narration is written as MP3 when `ffmpeg` is on your PATH, otherwise WAV.

## CLI

```text
pr2video voices [--json]                      List the free voices and whether each works here
pr2video speak <text> -o <path> [voice opts]  Speak one line
pr2video narrate <tour.json> [voice opts]     Narrate every scene of a tour
pr2video tour check <tour.json> [--json]      Validate a tour file
pr2video tour timeline <tour.json> [--vtt <out.vtt>] [--json]
pr2video render <tour.json> [--html <out.html>] [--mp4 <out.mp4>] [--fps 30] [--height 1080 | --size 1920x1080]
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

**Secrets.** The agent generates or fakes what it can (session secrets, a local database, a stub for
a vendor API) and asks you only for values nobody can make up, such as a test-mode payments key.
You set those yourself, in your own terminal, so they never pass through the chat:

```bash
pr2video sandbox env set STRIPE_SECRET_KEY                  # asks for the value without showing it
pr2video sandbox env import ~/app/.env STRIPE_SECRET_KEY    # or copy it from a file you have
```

Or add `NAME=value` lines to `.pr2video/secrets.env` in an editor. They stay in that file (readable
only by you, never committed) and reach the sandbox's
commands as environment variables. Recorded setup refers to them by name, and every log and piece of
output shows `***` in their place. Give test-mode keys, not live ones: the app in the sandbox can
use whatever it is given.

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

## Licences

pr2video is [MIT](LICENSE). What it makes, and what it is built from, carry their own terms:

- **Bundled code.** The published package and every tour's player include rrweb, zod and a few
  small packages inside rrweb, all MIT. Their notices are in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), shipped in the npm package, and at the top of
  the player script inside every tour HTML.
- **Narration.** The audio a voice makes is under that voice's terms:
  - Kokoro-82M is Apache-2.0, free to use and share.
  - macOS system voices (`say`): Apple's macOS licence allows them only in your own personal,
    non-commercial content, and rules out recording or publishing them for commercial, non-profit
    or public sharing. Do not share a tour narrated with `say`; narrate it again with kokoro.
  - Piper voice models each have their own licence, and some are non-commercial: check the voice's
    model card.
  - eSpeak NG is GPL-3.0; pr2video runs it as a separate program, and its speech is yours to use.
- **The recording.** A tour embeds a recording of your app: its text, images and the fonts it
  serves. Sharing the tour is sharing those; that is yours to decide.
- **Installed separately**, under their own licences: Playwright (Apache-2.0) and its Chromium,
  ffmpeg, kokoro-js (Apache-2.0), Piper, eSpeak NG, and the software the sandbox image is built
  from on your machine (Debian, Node, Docker). pr2video does not redistribute them.

pr2video is an independent project, not affiliated with Anthropic, OpenAI, Cursor, Google, Apple or
the authors of the voices and libraries it uses; their names are used only to say what pr2video
works with.

This section explains what we found in each licence; it is not legal advice.
