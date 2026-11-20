# pr2video

> [!WARNING]
> **Early version.** pr2video is new and changing fast: expect bugs, rough edges and breaking
> changes between versions. It runs the project's code in a Docker sandbox on your machine; use it
> at your own risk, and check a tour before you share it.

> [!NOTE]
> **Web apps only, for now.** pr2video films apps with a browser UI. CLIs, libraries, APIs with no
> page, and desktop or mobile apps are not supported yet: see [Scope](#scope).

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
  For a project with a Compose file the container runs its own Docker engine (for its databases
  and services), so it must be allowed to run **privileged** (or under Sysbox); other projects get
  an ordinary container. Rootless Docker and Podman are untested. The first run builds a
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
pr2video import <tour.html> -o <dir>          Import a tour exported as one HTML page (tour-data)
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
pr2video sandbox ps | logs | stop | journal [drop <n>] | status
pr2video sandbox ls [--all]                          Sandboxes, their memory, disk and last use
pr2video sandbox sleep                               Free a sandbox's memory, keep its disk
pr2video sandbox down                                Remove a sandbox
pr2video sandbox prune [--all] [--dry-run]           Clean up now (see "Disk, memory and cleanup")

pr2video scenes check [<scenes.json>]                Validate the scenes to film
pr2video record [--side head|base] [--only <id,id>]  Record them in the sandbox's browser (rrweb)
pr2video tour draft [--compare] [--fresh]            A tour.json from the recordings; keeps your captions
```

## The sandbox

Your project's code runs in Docker, not directly on your machine (but read [Security](#security)
before running code you do not trust). Each run gets one Docker container with the head at `/work/head` (a commit, or with `--folder` a
copy of the folder as it is, uncommitted files included) and the base, when there is one, at
`/work/base`, Node 24, Python and Chromium. A project with a Compose file (or `up --services`)
also gets its own Docker engine for its services (`docker compose` works inside), which makes the
container `--privileged` unless Docker has Sysbox; see [Security](#security). A local registry mirror caches Docker Hub pulls, and pnpm/npm caches persist across runs.
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

### Disk, memory and cleanup

What pr2video keeps in Docker, roughly, for a typical web app:

| What | Size | Kept |
|---|---|---|
| A sandbox (per run): checkout and installed dependencies | 1-6 GB disk, 1-2 GB memory while running | Until the policy below removes it |
| Its services' data (a database, their images) | up to a few GB | With its sandbox |
| The sandbox image | about 2.5 GB | The current version; older ones are removed |
| pnpm and npm caches (shared) | a few GB | Emptied above 10 GB |
| `pr2video-mirror`, a cache of Docker Hub pulls (shared) | 1-2 GB, a few MB of memory | Emptied above 10 GB |

The shared caches are what make later runs fast, for every project: installs come from the pnpm
store and Docker images from the mirror. A sandbox itself only helps while you are still changing
its tour. The setup it recorded, its saved data and the tour all live in your project's
`.pr2video/<run>/` folder, not in Docker, so removing a sandbox loses none of them. A new run of
the same project starts from them with `sandbox up --from <run>`.

**The policy.** When the tour is delivered, the agent runs `pr2video sandbox sleep`: the container
stops, freeing its memory, and keeps its disk. Any `sandbox` or `record` command wakes it, with its
services and servers started again as they were. The rest happens whenever a sandbox starts or goes
to sleep (there is no background job):

- a sandbox left running and unused for **1 hour** is put to sleep;
- one asleep for **3 days** is removed, and so is any asleep beyond the newest **3** (one still
  running is never removed);
- sandbox images no sandbox uses, and volumes whose sandbox is gone, are removed;
- a shared cache above **10 GB** is emptied, at most once a day and only while no sandbox runs.

**Changing it.** Set these in your shell profile (or for one command); each takes `off`:

```bash
export PR2VIDEO_SANDBOX_IDLE=20m      # sleep sooner (default 1h)
export PR2VIDEO_SANDBOX_TTL=1d        # remove sooner (default 3d); 0 or off: never
export PR2VIDEO_KEEP_SANDBOXES=1      # keep fewer (default 3); 0 keeps none asleep
export PR2VIDEO_CACHE_MAX=4g          # smaller caches, slower installs (default 10g)
```

To keep everything for fast repeat runs on a big machine, raise them or set them to `off`.

**By hand.** See what is there, then clean up now:

```bash
pr2video sandbox ls --all             # every project's sandboxes: memory, disk, last used
pr2video sandbox prune --dry-run      # what the policy would do now, caches included
pr2video sandbox prune                # do it
pr2video sandbox down --run <run>     # remove one sandbox
pr2video sandbox prune --all          # remove everything pr2video keeps in Docker
```

`prune --all` removes every sandbox (running ones too), the caches, the mirror, the images and
the network; the projects' `.pr2video/` folders stay, and the next run builds the rest again (the
image takes a few minutes). Without pr2video at hand, the same with Docker:

```bash
docker rm -f -v $(docker ps -aq --filter label=pr2video.run) pr2video-mirror
docker volume rm $(docker volume ls -q --filter label=pr2video.run) pr2video-pnpm-store pr2video-npm-cache pr2video-registry
docker rmi $(docker image ls -q pr2video-sandbox)
```

Sandboxes made by pr2video 0.0.8 or earlier kept their services' data in an unnamed volume, which
`docker rm` without `-v` leaves behind. `docker volume prune` removes unnamed volumes no container
uses, from every project on the machine, not only pr2video's: check `docker volume ls` first.

### Security

**The sandbox keeps a project from making a mess of your machine; it is not a security boundary
against code written to escape it.** How tight it is depends on the app:

- **An app without services in Docker** (no Compose file) gets an ordinary, unprivileged
  container: no Docker engine inside, Docker's default seccomp profile and capabilities. Getting
  out of it takes a kernel or Docker bug.
- **An app with a Compose file** (or `sandbox up --services`) gets its own Docker engine, which
  needs a `--privileged` container. Privileged code running as root can take over whatever runs
  Docker: on Linux, your computer; with Docker Desktop, its VM, which can see the folders you
  share with Docker (by default your whole home folder).
- **With Sysbox installed** (Linux), every sandbox runs under it instead (`--runtime=sysbox-runc`):
  its own Docker engine, without `--privileged`, in its own user namespace. pr2video finds it in
  `docker info`; `PR2VIDEO_RUNTIME=runc` turns that off.

`pr2video sandbox status` says which one a sandbox is. Run pr2video on code you would run yourself
anyway: your own work, your team's pull requests. For a stranger's pull request, see "Untrusted
code" below.

What pr2video does to limit the damage:

- **Nothing of your machine is mounted.** The commits (or, with `--folder`, the files git would
  keep) are streamed in; `.env` and other ignored files never enter the sandbox. Nothing is
  published on a host port, and the host's Docker socket is never mounted.
- **Limits** on memory, CPUs and processes, for everything in the sandbox, its services included
  (a memory leak or a fork bomb stops there):

  | Setting | Default |
  |---|---|
  | `PR2VIDEO_SANDBOX_MEMORY` | `8g` |
  | `PR2VIDEO_SANDBOX_CPUS` | half of Docker's CPUs, at least 2 |
  | `PR2VIDEO_SANDBOX_PIDS` | `8192` (processes and threads) |

  Each takes `off`; they apply to sandboxes created after the change. Disk is not limited: the
  cleanup policy above reclaims it.
- **Its own network.** A sandbox reaches the internet and the registry mirror, not other sandboxes.
- **What comes back is checked.** Recordings and saved data are copied out only if they are plain
  files and folders; a symlink (to `~/.ssh/...`, say) is refused.
- **The tour page loads nothing from outside.** A Content-Security-Policy keeps the recorded page's
  images, fonts and stylesheets from reaching any server when someone opens the tour; the replay
  runs no scripts.
- **Secrets** go in through stdin, never on a command line, and are scrubbed from all output. A
  value a recording caught on the page is replaced with `***`, and `render` refuses a tour that
  still holds one. Every command in the sandbox can read them, and the sandbox can reach the
  internet: give test-mode or restricted keys only.
- **Caches:** the pnpm and npm caches are shared by every project, so installs are quick. With
  `PR2VIDEO_CACHE_SCOPE=project` each project gets its own, so one project's code cannot plant a
  package another project installs.
- Images are pinned by digest.

What it does not do: limit outbound network traffic (installs and the app's own APIs need it), and
on Docker Desktop the sandbox can reach services on your machine through `host.docker.internal`.

**Tightening it yourself:**

- **Docker Desktop:** in Settings, Resources, cap the VM's CPUs, memory and disk (every sandbox
  shares them); in Resources, File sharing, share only the folders Docker needs instead of your whole
  home folder; on a Business plan, turn on Enhanced Container Isolation, which confines privileged
  containers to their own user namespace.
- **Linux:** install [Sysbox](https://github.com/nestybox/sysbox) (pr2video uses it by itself), or
  use rootless Docker, rather than a privileged container on a root Docker daemon.
- **Your agent:** keep its permission prompts on. The skill only runs a project's code through
  `pr2video sandbox`, but a project's files could try to talk an agent into more.

**Untrusted code:** point pr2video at a Docker that is not on your machine. pr2video uses the
`docker` CLI, so a Docker context or `DOCKER_HOST` sends everything there. pr2video mounts nothing
from your machine, so a remote engine should work, though we have not tested one yet:

```bash
docker context create scratch --docker host=ssh://you@throwaway-vm
DOCKER_CONTEXT=scratch pr2video sandbox up --head <sha>
```

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
