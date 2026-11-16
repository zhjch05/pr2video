---
name: pr2video
description: Turn a pull request into a narrated tour of the running app - an rrweb replay with captions, zoom, highlights and a voice, plus an optional MP4. Use when the user asks to demo, show, walk through or make a video of a pull request, a branch or a diff.
---

# pr2video

You make a short narrated tour that shows a reviewer what a pull request changed in the app, the way
an engineer would demo it to a teammate. **You do the thinking**: what the change is, how to get the app
running, which screens show it, and what to say. **The `pr2video` CLI does everything that must come out
the same every time**: the sandbox, recording, validation, the voice, and the HTML and MP4 output.
Run it with `npx pr2video` (or `pr2video` if installed). Pass `--json` when you need to act on the output.

Work in `.pr2video/<run>/` in the user's repository. Every file you write there is checked by a
`pr2video ... check` command: **loop until the check passes**, and never hand-edit what the CLI wrote.

## Phases

1. **Understand the change.** Read the diff (`gh pr diff <n>` or `git diff base...head`) and the code
   it touches. Write two sentences on what changed for a user of the app. If nothing visible changed
   (pure refactor, tests, CI), say so and stop: there is nothing to film.
2. **Get the app running** in the sandbox. Read [reference/setup.md](reference/setup.md) first.

   ```bash
   pr2video sandbox up --head <ref> --base <ref>     # head at /work/head, base at /work/base
   pr2video sandbox exec --record -- pnpm install    # runs inside; --record = a setup step
   pr2video sandbox start web --port 3000 --record -- pnpm dev
   ```

   Record only the steps that set the app up, so `pr2video sandbox replay` can rebuild the base
   commit from them. Explore without `--record`.
3. **Write the scenes** (`.pr2video/<run>/scenes.json`): 1-6 places in the app that show the change,
   each with a start URL, a few steps to get there and checkpoints to stop on, with captions. See
   [reference/scenes.md](reference/scenes.md). Find button names, labels and routes in the code;
   check a page with `pr2video sandbox exec -- curl -s http://localhost:<port>/<path>` if unsure.

   ```bash
   pr2video scenes check
   pr2video record --side head          # in the sandbox's browser; screenshots in recordings/head/
   ```

   Look at each checkpoint's screenshot (`recordings/head/<scene>/<checkpoint>.png`). A scene that
   stopped says where and why in `result.json` (with `stopped.png`): fix the step and record it
   again with `--only <scene>`. Then record the base, to compare:

   ```bash
   pr2video sandbox replay              # the recorded setup, on the base commit
   pr2video record --side base          # the same scenes; stopping early on the base is expected
   ```

4. **Write the tour.** Start from a draft of what the head recorded, then edit it: order, captions
   (check them against the screenshots), and mark tones - compare the head and base screenshots to
   tell `added` from `changed`. See [reference/tour.md](reference/tour.md).

   ```bash
   pr2video tour draft                  # .pr2video/<run>/tour.json
   pr2video tour check .pr2video/<run>/tour.json
   ```

5. **Narrate** with a free local voice (no key; `auto` picks the best one installed):

   ```bash
   pr2video voices                       # what works on this machine, and how to install the rest
   pr2video narrate .pr2video/<run>/tour.json --voice auto
   pr2video tour timeline .pr2video/<run>/tour.json --vtt .pr2video/<run>/captions.vtt
   ```

   Narration reuses a clip whose caption did not change, so edit captions and narrate again freely.

6. **Deliver.** Render the tour as one HTML file, and as an MP4 when the user wants a video:

   ```bash
   pr2video render .pr2video/<run>/tour.json --html .pr2video/<run>/tour.html
   pr2video render .pr2video/<run>/tour.json --mp4 .pr2video/<run>/tour.mp4   # needs ffmpeg + Chromium
   ```

   The MP4 takes a few minutes: run it in the background. Tell the user where the files are, the
   tour's length, and any scene you could not reach and why.

## Rules

- Run the pull request's code only through `pr2video sandbox exec` / `start`, never directly on the
  user's machine, unless the user tells you to.
- Never invent what is on screen: captions describe only what a checkpoint recorded.
- Say when a scene could not be reached instead of filming the wrong page.
