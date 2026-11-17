# Design

## What it is for

pr2video's value is the environment, not the video: reproduce a web app from its source in a
sandbox (dependencies, services, data, sign-in), drive it in a real browser the way a person tests
it, and record what it did. The tour is the evidence of that run. A model can already make a video
of what it imagines an app does; pr2video records what the app does.

Scope is web apps with a browser UI. Changes without a screen (terminal tools, database
migrations, APIs nothing shows, libraries) and non-web apps are out of scope for now. Candidates
for later: dedicated skills for terminal sessions, database changes and API changes, each with its
own way to show a result, and general computer use to record non-web apps.

## The split

The user's agent (Claude Code or another coding agent, on their tokens) does all the model work. The CLI makes no model calls.

| Phase | The agent | The CLI |
|---|---|---|
| Read the change | reads the diff and code with its own tools | `init`: head and base checkouts, the diff, the run directory |
| Get the app running | chooses commands, fixes failures | `sandbox up`, `exec -- <cmd>` (inside the container), the command journal, `replay --side base`, caches |
| Scenes | writes `scenes.json` | `scenes check`, `record --side head\|base`, `snapshot`, `try` |
| Tour | writes `tour.json` | `tour check`, `tour timeline` |
| Narration | - | `voices`, `narrate` (free local voices) |
| Output | - | `render --html`, `render --mp4` |

Whatever the agent writes goes through a `check` command that is as strict as a schema can make it.
The skill tells the agent to loop until it passes. That replaces the strict tool schemas and limits a
tool cannot enforce on someone else's model.

## Packages

- `@pr2video/tour`: the tour format (zod) and its timeline: pacing, zoom, captions, WebVTT. Pure, so
  the player and the MP4 renderer draw exactly the same thing.
- `@pr2video/voice`: free local voices (kokoro, say, piper, espeak) and tour narration.
- `@pr2video/player`: the player (vanilla TypeScript + rrweb, bundled into one script) and the
  self-contained page around it; `frame.ts` is the pure frame state both modes draw.
- `@pr2video/recorder`: the scenes format and check, the recorder that runs inside the sandbox
  (bundled to one `record.mjs`; Playwright and rrweb come from the image), and `tour draft`.
- `@pr2video/sandbox`: the Docker sandbox, its journal, replay and saved data.
- `pr2video`: the CLI, including `render` (HTML, MP4) and `import` (tours exported as one HTML page).
  The only published package: its build bundles the five others into it.
- `skills/pr2video/`: the agent skill and its references, for any agent that reads `SKILL.md`.
- `.claude-plugin/` and `commands/`: the repository root is also the Claude Code plugin, adding the
  `/pr2video` command.

## The sandbox

One container per run, standing in for a cloud sandbox:

```
host                                           per-run container, --privileged
pr2video CLI  ──docker exec──▶  checkout or folder copy, node, Chromium + recorder
host registry mirror (pull cache) ◀── pulls ── dockerd (DinD): postgres, redis, ... on its host network
                                               the app on localhost (head, then base)
```

- The project's code runs in a throwaway container, not as the user.
- The head is a commit (`--head`, default `HEAD`) checked out from the host repository, or with
  `--folder` (always, outside git) a copy of the project folder as it is: in git, the files git
  would keep (tracked and untracked, not ignored); otherwise all but `node_modules`, `.git` and
  similar caches (`FOLDER_EXCLUDES`). The copy is committed once inside. A folder has a base only
  when `--base` names a commit, so a tour of the app with no change has no base and no "before".
- Services run inside the container's own Docker, so recipes see `localhost` as in any sandbox.
- The image must be native multi-arch (arm64 on Apple Silicon); runc cannot create namespaces under qemu.
- Caches: a host-side `registry:2` pull-through mirror, a shared pnpm store volume, and the seeded
  services' data as tarballs (`save`, `up --from`). Back up data, never Docker's image store.
- The checkout lives on the container's filesystem; bind mounts are slow on macOS. The repository
  is mounted read-only at `/src` only to fetch from (the head and base commits, by hash), so any
  local commit, branch or pull request ref can be the head or base. Uncommitted changes are not
  included.
- The inner engine's data is an anonymous volume (overlayfs cannot sit on overlayfs), removed with
  the container. dockerd starts in the entrypoint after moby's cgroup v2 nesting step.
- The registry mirror and every sandbox share the `pr2video` network. On a machine whose default
  address pools are used up, the network falls back to a `10.217.x.0/24` subnet.
- `exec` passes the command in an environment variable and `eval`s it under `bash -l`, so quoting
  survives. `start` runs it under `setsid nohup`, so `stop` kills the whole process group.
- The journal (`.pr2video/<run>/journal.jsonl`) holds only `--record`ed steps that succeeded, and
  `cp --record` copies (the file is kept under the run's `files/`). `replay` stops every
  background process, rewrites `/work/head` to `/work/base`, and stops at the first failure. Making
  steps replayable is the agent's job (`skills/pr2video/reference/setup.md`).
- `up` fetches only the head and base commits into the sandbox (`--depth 1` from the read-only
  `/src`). On the host it first deepens a shallow clone until the merge base is there, and fetches a
  partial clone's missing files of both commits in one batch (`fetch --stdin`, as git's lazy fetch
  does), since nothing can fetch lazily through the read-only mount.
- The seeded-data cache: `save` stops the inner containers, tars every inner Docker volume's
  `_data` and the given paths to `.pr2video/<run>/data.tgz` (manifest `data.json`: the journal
  length it covers), and starts them again. `up --from <run>` copies that run's journal, kept files
  and scenes, creates the volumes, untars, and replays on the head skipping the `--data` steps the
  snapshot covers. Volume directories are restored under a running dockerd by creating each volume
  first, so its metadata store is never written behind its back.

## The renderer

Frame-stepped, not screen-captured. The page opened with `?render` has no controls and no clock;
`window.pr2video.seek(t)` draws the frame at tour time `t` (`frameAt`: the replayer paused at the
moment's `recordingMs`, the zoom eased by a computed curve rather than a CSS transition, marks and
caption from the timeline) and resolves once it is painted. Headless Chromium screenshots each frame
(JPEG) into `ffmpeg` (x264, yuv420p); a second pass mixes the narration clips in at
`narrationOffsets(timeline)` with `adelay` + `amix`. Slower than recording the screen, but
deterministic: no dropped frames, full quality, and identical to the HTML tour.

- The page is the recording's viewport; `deviceScaleFactor` sets the output size (`--height`).
- The mouse tail is off in render mode: rrweb draws it on the wall clock.
- `waitUntil: "domcontentloaded"`: a recording's own stylesheets and fonts point at the recorded app's
  origin, which is gone, and `load` can wait on them for a long time.

## Recording

The agent writes `scenes.json`: per scene a start URL, steps from a closed vocabulary (goto, click,
hover, fill, select, check, press, waitFor, wait, scrollTo) with semantic locators, and checkpoints
with a caption, a focus and marks. No code, so the same scene runs on the head and the base.

- `pr2video record` copies `record.mjs` and the scenes into the sandbox (`/opt/pr2video`, where the
  image installed Playwright and rrweb), runs it, and copies `/tmp/pr2video-out/<side>` back to
  `.pr2video/<run>/recordings/<side>/`. Changing the recorder never rebuilds the image.
- Roles sign in once each in an unrecorded context; their storage state seeds their scenes.
- rrweb starts by `addInitScript` on the app's origin only (it crashes on about:blank), inlines
  stylesheets, images and fonts, and streams events through an exposed binding.
- A checkpoint: settle, centre the focus, measure focus and marks (box + rrweb mirror id), flush,
  screenshot, then keep recording 700 ms. Times are anchored to the first event (`atMs`, `shotMs`).
- On the head a missing focus stops the scene (it is on the wrong page); on the base it is only
  listed as missing. A failed step ends the scene with `stopped.png` and the error.
- `tour draft` makes one tour scene per checkpoint, each a window of its recording from the
  previous checkpoint's screenshot to the next checkpoint.
