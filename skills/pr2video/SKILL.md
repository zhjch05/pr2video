---
name: pr2video
description: Make a narrated video tour of a web app from its source folder, by running it in a sandbox and using it like a person testing it - an rrweb replay of the real UI with captions, zoom, highlights and a voice, as HTML or MP4. Web apps with a browser UI only. Use when the user asks to demo, show, walk through or make a video of a pull request, a branch, a diff or uncommitted work, or of the app itself (a feature, a flow, an onboarding tour).
license: MIT
compatibility: Needs Node 24+, Docker (the app runs in a sandbox container), git, and for an MP4 ffmpeg and Playwright's Chromium. Works in any agent that can run shell commands.
metadata:
  version: "0.0.11"
---

# pr2video

You make a short narrated tour of a web app, the way an engineer would demo it to a teammate: what a
pull request or other change did, or simply a feature or flow the user names. **You do the thinking**:
what to show, how to get the app running, which screens show it, and what to say. **The `pr2video` CLI does everything that must come out
the same every time**: the sandbox, recording, validation, the voice, and the HTML and MP4 output.
This skill is written for pr2video 0.0.11: if `pr2video --version` does not print that (or you
were told to use npx), use `npx -y pr2video@0.0.11` wherever this skill says `pr2video`, so the
commands and flags match what is written here. A shell function is the easy way, in any shell:
`pr2video() { npx -y pr2video@0.0.11 "$@"; }` (a variable holding the command does not split into
words in zsh). Pass `--json` when you need to act on the output.

Work in `.pr2video/<run>/` in the user's project folder: `sandbox up` prints it (the run is named
after the head commit, its first 10 characters, or `folder-...` for a folder). Every file you write there is checked by a
`pr2video ... check` command: **loop until the check passes**, and never hand-edit what the CLI wrote
(in `tour.json`, the parts the tour reference says are yours to edit are the exception).

## Phases

1. **Decide what the tour shows.** pr2video films web apps with a browser UI only. If the project
   has none (a CLI or terminal tool, a library, a desktop or mobile app), say so and stop: there is
   no screen to record, and an invented one is not a tour. There are two kinds of tour:
   - **A change** (a pull request, a branch, a commit range, or uncommitted work): read the diff
     (`gh pr diff <n>`, `git diff base...head`, or `git diff` for uncommitted work) and the code it
     touches, and write two sentences on what changed for a user of the app. The tour shows the
     change, with "before" scenes from the base where they help.
     - Nothing visible changed (a refactor, tests, CI): say so and stop. There is nothing to film.
     - Only an API changed: find the screen that shows its result and film that. If no screen uses
       it, tell the user before filming; a raw JSON response replays as one unstyled line (the
       browser's JSON viewer is not part of the page), so it makes a poor tour.
   - **The app itself** (a feature, a flow, a first-run tour, a demo): there is no diff and no base.
     Read the code for the screens and the steps the user asked about; if they named none, pick the
     few flows that show what the app is for. Write two sentences on what the tour will show.
2. **Get the app running** in the sandbox. Read [reference/setup.md](reference/setup.md) first.
   Start it the way that matches step 1:

   ```bash
   pr2video sandbox up --head <ref> --base <ref>     # a change in commits: head at /work/head, base at /work/base
   pr2video sandbox up --folder                      # the folder as it is: uncommitted files included, no base
   pr2video sandbox up --folder --base HEAD          # uncommitted work, with the last commit as its base
   ```

   The app may need values nobody can make up (a real API key): reference/setup.md says how to tell
   those blockers from what you can generate or fake, and how to ask the user for them. Never ask
   for a secret in the chat: the user sets it with `pr2video sandbox env set <NAME>`.

   Outside a git repository `sandbox up` always copies the folder. A copied folder leaves out
   `node_modules`, `.git` and similar caches (and, in git, ignored files such as `.env`): install
   and build inside, as for a commit. Then:

   ```bash
   pr2video sandbox exec --record -- pnpm install    # runs inside; --record = a setup step
   pr2video sandbox start web --port 3000 --record -- pnpm dev
   ```

   Record only the steps that set the app up, so `pr2video sandbox replay` can rebuild the base
   from them. Explore without `--record`. A replay runs every recorded step again, build included,
   so it takes about as long as the setup did.

   If `.pr2video/` already holds a run of this project with recorded setup (`ls .pr2video`, then
   `pr2video sandbox journal --run <run>`), start from it instead: add `--from <run>` to the `up`
   command, which replays that setup on the new head, restoring its saved data if it has any. Fix
   and re-record only the steps that fail.
3. **Write the scenes** (`.pr2video/<run>/scenes.json`): 1-6 places in the app that show the change
   (or the feature),
   each with a start URL, a few steps to get there and checkpoints to stop on, with captions. Each
   checkpoint outlines the things its caption names, and each outline gets a short label saying what
   to notice: an outline alone is easy to miss. See
   [reference/scenes.md](reference/scenes.md). Find button names, labels and routes in the code,
   then check them on the live page before recording:

   ```bash
   pr2video probe /settings --role admin                                   # headings, controls, fields
   pr2video probe /settings --role admin --find '{"role":"switch","name":"Dark mode"}'   # what a locator matches
   ```

   ```bash
   pr2video scenes check
   pr2video record --side head          # in the sandbox's browser; screenshots in recordings/head/
   ```

   Pick the browser size the change needs: a change for narrow screens (CSS breakpoints, mobile
   layout) needs a phone viewport. Give one scene its own `viewport` to show the same screen at
   several widths. Look at each checkpoint's screenshot (`recordings/head/<scene>/<checkpoint>.png`).
   A scene that stopped says where and why in `result.json` (with `stopped.png`): fix the step and
   record it again with `--only <scene>` (or `--only a,b`); other scenes' recordings are kept. Get the head
   right before recording the base: re-recording a head scene afterwards needs `replay --side head`,
   which runs the whole setup again. With a base, record it too:

   ```bash
   pr2video sandbox replay              # the recorded setup, on the base commit
   pr2video record --side base          # the same scenes; stopping early on the base is expected (a step waits at most 8s there)
   pr2video sandbox replay --side head  # back to the head, if you need to re-record a head scene
   ```

4. **Write the tour.** Start from a draft of what the head recorded, then edit it: order, captions
   (check them against the screenshots), and mark tones - compare the head and base screenshots to
   tell `added` from `changed`. A tour of the app with no change uses `note` for every mark, and
   its captions say what the user can do, not what changed. See [reference/tour.md](reference/tour.md).

   ```bash
   pr2video tour draft                  # .pr2video/<run>/tour.json
   pr2video tour draft --compare        # with a base: each checkpoint the base reached, shown first as "before"
   pr2video tour draft --before home-banner,settings   # only these: <scene>-<checkpoint>, a scene id or a checkpoint id
   pr2video tour draft --before a,b     # or a "before" only for the checkpoints that need one
   pr2video tour check .pr2video/<run>/tour.json
   pr2video render .pr2video/<run>/tour.json --frame 4000,12000 --png .pr2video/<run>/stills/s   # stills, as the video draws them
   ```

   With `--compare`, a checkpoint whose base screenshot looks the same as the head's gets no
   "before" (the draft lists them as left out). A "before" earns its place when the base shows
   something to compare (the old value, the old layout), not when it only lacks what the head
   adds: name those with `--before`. A tour has at most 12 scenes, and `tour check` holds it to that. Write the other "before" captions from the base
   screenshot:
   `tour check` refuses the draft's TODO. Drafting again after re-recording keeps the scenes, order,
   captions and zooms you wrote and takes fresh timings, focus and marks; change focus and marks in
   `scenes.json`, where they survive re-recording (`--fresh` starts the tour over). Look at a few `--frame` stills before rendering the MP4; the replay can differ from
   the screenshots (see tour.md), and a still takes seconds where the MP4 takes about a third of the tour's length.

5. **Narrate** with a free local voice (no key; `auto` picks the best one installed):

   ```bash
   pr2video voices                       # what works on this machine, and how to install the rest
   pr2video narrate .pr2video/<run>/tour.json --voice auto
   pr2video tour timeline .pr2video/<run>/tour.json --vtt .pr2video/<run>/captions.vtt
   ```

   Narration takes about 10 seconds a clip with kokoro, and reuses a clip whose caption did not
   change, so edit captions and narrate again freely. The voice reads every character of a code,
   colour or id (`#767676`, `rgb(170, 170, 170)`): name such values sparingly in captions.
   When `narrate` prints a `note` about the voice's licence (macOS `say`: personal, non-commercial
   use only; Piper: per model), pass it on to the user with the files, and offer kokoro if the tour
   will be shared.

6. **Deliver.** Render the tour as one HTML file, and as an MP4 when the user wants a video:

   ```bash
   pr2video render .pr2video/<run>/tour.json --html .pr2video/<run>/tour.html
   pr2video render .pr2video/<run>/tour.json --mp4 .pr2video/<run>/tour.mp4   # needs ffmpeg
   ```

   The MP4 and `--frame` stills draw in Chromium: if `render` says it cannot start Chromium, run
   `pr2video browser install` once.

   The MP4 takes about a third of the tour's length, more on a machine with few cores. Its shape follows the first scene's
   viewport (a phone viewport gives a portrait video). Tell the user where the files are, the
   tour's length, and any scene you could not reach and why.

7. **Put the sandbox to sleep** once the files are delivered:

   ```bash
   pr2video sandbox sleep
   ```

   It frees the sandbox's memory (1-2 GB) and keeps its disk, so changes the user asks for next
   are quick: any `pr2video sandbox` or `record` command wakes it, with its services and servers
   started again as they were. One asleep for three days is removed (its setup stays in
   `.pr2video/<run>/`). Run `pr2video sandbox down` instead only when the user says they are done
   with it.

## Rules

- Run the project's code only through `pr2video sandbox exec` / `start`, never directly on the
  user's machine, unless the user tells you to.
- Never invent what is on screen: captions describe only what a checkpoint recorded.
- Say when a scene could not be reached instead of filming the wrong page.
- Never read, print or film a secret's value; commands name it (`$NAME`).
