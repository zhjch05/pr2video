# Setting the app up in the sandbox

The sandbox is a Linux container (Debian, Node 24 with corepack, Python 3, git, ripgrep, psql, jq,
curl) with **its own Docker engine**: `docker run` and `docker compose` work inside it, and their
published ports are on the sandbox's `localhost`. Chromium for Playwright is installed. The head is
checked out at `/work/head` and the base at `/work/base`, both detached and without history (a
project that needs it, for `git describe` say, can `git fetch /src <ref>` inside). With `up
--folder` (or outside git), `/work/head` is instead a copy of the project folder as it was,
uncommitted files included but not `node_modules`, `.git`, ignored files or similar caches, committed
once inside so `git status` there shows what setup changed. Shallow and
partial clones work: `sandbox up` fetches what they lack on the host first. The recorder's own
Chromium lives in `/opt/pr2video`, apart from anything the project installs: a project that runs
`playwright install` cannot break recording. pnpm and npm caches persist
across runs, and Docker Hub pulls go through a local cache.

## How commands are passed

After `--`, **one argument is a shell command as written**:
`pr2video sandbox exec -- 'npm ci && npm run build'`. **Several arguments are an argv**, quoted for
you: `pr2video sandbox exec -- sh -c 'echo one; echo two'`. Commands run as root under `bash -l`,
in `/work/head` unless you pass `--cwd`.

The host's project folder is only mounted read-only at `/src`, for checking out and copying; never
work there. `/work/head` and `/work/base` are the sandbox's own copies. To bring in a file you wrote (a seed script, a fixture), copy it:
`pr2video sandbox cp --record ./seed.cjs /opt/seed/seed.cjs`, then record a step that runs it.
`--record` keeps a copy in the run and journals the copy, so replay brings the same file. Keep it out
of the project's own files and under `.pr2video/<run>/` on the host.

## Node versions

The sandbox has Node 24. A project that pins another (`.nvmrc`, `engines`, `volta`) usually runs
on 24; if it does not, run that version for the project's commands with `npx -y node@<version>`
(e.g. `npx -y node@18 node_modules/.bin/vite build`), recorded like any other step.

## How to work

1. Read how the project runs before running anything: `README`, `package.json` scripts,
   `docker-compose.yml`, `.env.example`, CI workflows (`.github/workflows/*`), `Makefile`, `Procfile`.
2. Run each setup step with `pr2video sandbox exec --record -- <command>`. It ends by printing the
   exit code and the step's number. A step that fails is not recorded: fix it and run it again. To
   take back a step that succeeded but was wrong, `pr2video sandbox journal drop <n>`. Use `--json`
   when you need the exit code and output; the full output of every command is in
   `.pr2video/<run>/logs/`.
3. Start servers with `pr2video sandbox start <name> --port <port> --record -- <command>`. It waits
   until the port answers on `127.0.0.1` or `::1` with a status below 500, and fails early if the
   process exits; then read `pr2video sandbox logs <name>`. A start whose port never answers is not
   recorded. If a temporary server answers first (a migration screen), add
   `--path` with a route only the real app serves, e.g. `--path /api/health`.
4. Check the app answers: `pr2video sandbox exec -- curl -sI http://localhost:<port>/`.

## Make every recorded step replayable

`pr2video sandbox replay` runs the recorded steps again in `/work/base` (paths under `/work/head`
are rewritten) after stopping every background process. So each recorded step must work a second
time, on the base:

- Prefer `docker compose up -d` (idempotent) over `docker run --name ...`; if you must, write
  `docker rm -f db 2>/dev/null; docker run -d --name db ...`.
- Write config with `cp -n .env.example .env` or a heredoc, never by hand-editing in place.
- Reset the database before migrating and seeding when the base's schema differs: record a step
  that drops and recreates it.
- Do not record exploration (`ls`, `cat`, `curl`): it only slows the replay.
- The image has Node 24 (with corepack), Python 3, git, curl and Docker. Install anything else the
  project needs (Go, Rust, Java, Ruby) as a recorded step, from the official release at the version
  the project names (`go.mod`, `rust-toolchain`, `.tool-versions`), or run it with `docker run` or
  the project's compose file. Keep it outside `/work/head`, e.g. `/opt/go`, so replay reuses it.
- Record setup steps only while working on the head. Something you find you need while on the base
  (a warm-up, a missing file) belongs in the journal too: add it, then `replay` again.

## Seeding data

Most changes only show with data: items in a list, a record to open. Create it through the app's
own API or a script, as a recorded step after the server is up, so a base gets the same data.
Read the app's tests (e2e helpers, fixtures) for how they create users and records; they are
usually the shortest path. First-run setup wizards (create the admin account) are often an API call.

## Saving the setup for next time

A later run of the same project (the next push, another pull request, another tour) can start from this one:
`pr2video sandbox up --from <run>` copies this run's journal and kept files and replays them on its
head. When seeding or installing a toolchain is slow, save what it made once the head is set up:

- Record such steps with `--data` instead of `--record`: steps that only write services' data or a
  path you will save (`/opt/go`), never the checkout.
- Then `pr2video sandbox save --path /opt/go`: it keeps every volume of the sandbox's Docker (the
  services' data; use named volumes, not bind mounts into the checkout) and the paths you give.
- `up --from` restores them and skips the `--data` steps; every other step runs again. Migrations
  then run against the restored data, so keep them able to run twice.

## Secrets and outside services

The app can reach the internet from the sandbox (it needs it to install packages), so it may fetch
favicons, fonts or previews from other sites while you record. Prefer settings that turn such
fetches off, and never give it real accounts or keys.


Never invent real credentials. Use the project's example values, a local double (a Postgres in
Docker instead of a hosted one), or ask the user. If the app cannot start without an outside
service you cannot stand in for, stop and say which one.
