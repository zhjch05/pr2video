# pr2video

Turn a pull request into a narrated tour of the running app: a replay of the real UI with zoom,
highlights, captions and a voice, as a self-contained HTML file or an MP4.

pr2video is a **Claude Code plugin plus a CLI**. Your agent, on your own tokens, does the thinking: it
reads the change, gets the app running, picks the screens and writes what to say. The CLI does
everything that has to come out the same every time: the sandbox, the recording, validation, the
voice and the video. No account and no API key: every voice is free and runs on your machine.

> **Status: early.** The tour format, narration, the player and the HTML/MP4 renderer work today.
> The sandbox and recording are next; see [docs/design.md](docs/design.md).

## Install

```bash
# The Claude Code plugin (skill + /pr2video command)
/plugin marketplace add <owner>/pr2video
/plugin install pr2video@pr2video

# The CLI (Node 24+)
npm install -g pr2video
npm install -g kokoro-js                                  # optional: the most natural free voice
npm install -g playwright && npx playwright install chromium   # for MP4 (plus ffmpeg on PATH)
```

Then, in Claude Code: `/pr2video https://github.com/acme/shop/pull/12`.

## Voices

All free and local. `--voice auto` (the default) picks the best one available.

| Voice | Quality | Needs |
|---|---|---|
| `kokoro` | Natural (Kokoro-82M, Apache-2.0) | `npm i kokoro-js`; ~90 MB model downloaded on first use to `~/.cache/pr2video` |
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
```

## Output

- **HTML**: one file with the player, every recording (gzipped) and the narration inline. It opens
  from disk with no network: play, pause, seek, speed, mute, captions, and a list of scenes.
- **MP4**: H.264 + AAC, rendered frame by frame from the same page in headless Chromium, so it
  matches the HTML tour exactly. About 80-100 ms a frame on a laptop: a 90-second tour at 30 fps
  takes three to four minutes.

## Development

```bash
pnpm install
pnpm check-types && pnpm lint && pnpm test && pnpm build
pnpm pr2video --help        # runs the CLI from source
```

## License

MIT
