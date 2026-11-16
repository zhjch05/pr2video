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
2. **Get the app running** in the sandbox, for the head and then the base commit.
   *Not built yet* (`pr2video sandbox up`, `pr2video exec`). For now, ask the user for a URL where the
   head build already runs, and the sign-in it needs.
3. **Choose 3-6 scenes.** A scene is a place in the app plus the state that shows the change, the
   role that sees it, at most 5 actions to get there, and at most 6 checkpoints to stop on.
   *Not built yet* (`pr2video scenes check`, `pr2video record`).
4. **Write the tour** (`tour.json`): which checkpoints to show, in what order, a caption for each,
   where to zoom and what to mark. See [reference/tour.md](reference/tour.md) for the format and the
   rules for captions. Then:

   ```bash
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

- Run the pull request's code only inside the sandbox, never directly on the user's machine, unless
  the user tells you to.
- Never invent what is on screen: captions describe only what a checkpoint recorded.
- Say when a scene could not be reached instead of filming the wrong page.
