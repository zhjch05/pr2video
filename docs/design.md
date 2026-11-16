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
- `pr2video`: the CLI.
- `plugin/`: the Claude Code plugin: the skill, its references, the `/pr2video` command.

## The sandbox (next)

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
- The checkout lives on the container's filesystem; bind mounts are slow on macOS.

## The renderer (next)

Frame-stepped, not screen-captured: the player gets a render mode in which the frame at time `t` is a
pure function of `t` (the replayer paused at `momentAt(...).recordingMs`, zoom and marks from the
timeline). Headless Chromium screenshots each frame at 30 fps into `ffmpeg`, and the narration clips
are mixed at `narrationOffsets(timeline)`. Slower than recording the screen, but deterministic: no
dropped frames, full quality, and identical to the HTML tour.
