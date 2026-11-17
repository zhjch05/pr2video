# Third-party notices

pr2video is MIT-licensed (see [LICENSE](LICENSE)). Its published files include code from the
packages below, bundled in. Each is under the MIT License, whose text follows the table. Every tour
page pr2video makes (HTML, and the page an MP4 is drawn from) carries the same notice at the top of
its player script.

| Package | Copyright | Where |
|---|---|---|
| rrweb (with rrweb-snapshot, rrdom and @rrweb/utils) | Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors) | the tour player |
| @xstate/fsm (inside rrweb) | Copyright (c) 2015 David Khourshid | the tour player |
| mitt (inside rrweb) | Copyright (c) 2021 Jason Miller | the tour player |
| base64-arraybuffer (inside rrweb) | Copyright (c) 2012 Niklas von Hertzen | the tour player |
| zod | Copyright (c) 2025 Colin McDonnell | the CLI, the recorder and the tour player |

Everything else pr2video uses is installed or downloaded separately, under its own licence: Playwright
(Apache-2.0, an npm dependency) and the Chromium it installs, kokoro-js and the Kokoro-82M model
(Apache-2.0), Piper and its voice models (each model has its own licence), eSpeak NG (GPL-3.0, run
as a separate program), ffmpeg, and the Debian, Node and Docker software the sandbox image is
built from on your machine.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
