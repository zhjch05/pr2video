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
   it touches. Write two sentences on what changed for a user of the app.
   - Nothing visible changed (a refactor, tests, CI): say so and stop. There is nothing to film.
   - Only an API changed: find the screen that shows its result and film that. If no screen uses
     it, tell the user before filming; a raw JSON response replays as one unstyled line (the
     browser's JSON viewer is not part of the page), so it makes a poor tour.
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

   Pick the browser size the change needs: a change for narrow screens (CSS breakpoints, mobile
   layout) needs a phone viewport. Give one scene its own `viewport` to show the same screen at
   several widths. Look at each checkpoint's screenshot (`recordings/head/<scene>/<checkpoint>.png`).
   A scene that stopped says where and why in `result.json` (with `stopped.png`): fix the step and
   record it again with `--only <scene>` (or `--only a,b`); other scenes' recordings are kept. Then record the base:

   ```bash
   pr2video sandbox replay              # the recorded setup, on the base commit
   pr2video record --side base          # the same scenes; stopping early on the base is expected
   pr2video sandbox replay --side head  # back to the head, if you need to re-record a head scene
   ```

4. **Write the tour.** Start from a draft of what the head recorded, then edit it: order, captions
   (check them against the screenshots), and mark tones - compare the head and base screenshots to
   tell `added` from `changed`. See [reference/tour.md](reference/tour.md).

   ```bash
   pr2video tour draft                  # .pr2video/<run>/tour.json
   pr2video tour draft --compare        # or: each checkpoint the base reached, shown first as "before"
   pr2video tour check .pr2video/<run>/tour.json
   pr2video render .pr2video/<run>/tour.json --frame 4000,12000   # stills, exactly as the video draws them
   ```

   With `--compare`, delete each "before" scene where the base looks the same as the head (a step
   that only types, say), and write the rest of the "before" captions from the base screenshot:
   `tour check` refuses the draft's TODO. Drafting again after re-recording keeps the scenes, order,
   captions and zooms you wrote and takes fresh timings, focus and marks; change focus and marks in
   `scenes.json`, where they survive re-recording (`--fresh` starts the tour over). Look at a few `--frame` stills before rendering the MP4; the replay can differ from
   the screenshots (see tour.md), and a still takes seconds where the MP4 takes minutes.

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

   The MP4 takes a few minutes: run it in the background. Its shape follows the first scene's
   viewport (a phone viewport gives a portrait video). Tell the user where the files are, the
   tour's length, and any scene you could not reach and why.

## Rules

- Run the pull request's code only through `pr2video sandbox exec` / `start`, never directly on the
  user's machine, unless the user tells you to.
- Never invent what is on screen: captions describe only what a checkpoint recorded.
- Say when a scene could not be reached instead of filming the wrong page.
