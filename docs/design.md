# Design

## The split

The user's agent (Claude Code, on their tokens) does all the model work. The CLI makes no model calls.

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
- `pr2video`: the CLI, including `render` (HTML, MP4) and `import` (better-review tour downloads).
- `plugin/`: the Claude Code plugin: the skill, its references, the `/pr2video` command.

## The sandbox

One container per run, standing in for a cloud sandbox:

```
host                                           per-run container, --privileged
pr2video CLI  ──docker exec──▶  PR checkout, node, Chromium + recorder
host registry mirror (pull cache) ◀── pulls ── dockerd (DinD): postgres, redis, ... on its host network
                                               the app on localhost (head, then base)
```

- The pull request's code runs in a throwaway container, not as the user.
- Services run inside the container's own Docker, so recipes see `localhost` as in any sandbox.
- The image must be native multi-arch (arm64 on Apple Silicon); runc cannot create namespaces under qemu.
- Caches: a host-side `registry:2` pull-through mirror, a shared pnpm store volume, and the seeded
  services' data directories as tarballs. Back up data, never Docker's image store.
- The checkout lives on the container's filesystem; bind mounts are slow on macOS. The repository
  is mounted read-only at `/src` only to fetch from (`git fetch /src '+refs/*:refs/src/*'`), so any
  local commit, branch or pull request ref can be the head or base. Uncommitted changes are not
  included.
- The inner engine's data is an anonymous volume (overlayfs cannot sit on overlayfs), removed with
  the container. dockerd starts in the entrypoint after moby's cgroup v2 nesting step.
- The registry mirror and every sandbox share the `pr2video` network. On a machine whose default
  address pools are used up, the network falls back to a `10.217.x.0/24` subnet.
- `exec` passes the command in an environment variable and `eval`s it under `bash -l`, so quoting
  survives. `start` runs it under `setsid nohup`, so `stop` kills the whole process group.
- The journal (`.pr2video/<run>/journal.jsonl`) holds only `--record`ed steps. `replay` stops every
  background process, rewrites `/work/head` to `/work/base`, and stops at the first failure. Making
  steps replayable is the agent's job (`plugin/skills/pr2video/reference/setup.md`).
- Not yet: the seeded-data cache (tarballs of service data directories).

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
