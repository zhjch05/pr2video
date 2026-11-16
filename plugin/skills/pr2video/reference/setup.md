# Setting the app up in the sandbox

The sandbox is a Linux container (Debian, Node 24 with corepack, Python 3, git, ripgrep, psql, jq,
curl) with **its own Docker engine**: `docker run` and `docker compose` work inside it, and their
published ports are on the sandbox's `localhost`. Chromium for Playwright is installed. The head is
checked out at `/work/head` and the base at `/work/base`, both detached and without history (a
project that needs it, for `git describe` say, can `git fetch /src <ref>` inside). Shallow and
partial clones work: `sandbox up` fetches what they lack on the host first. The recorder's own
Chromium lives in `/opt/pr2video`, apart from anything the project installs: a project that runs
`playwright install` cannot break recording. pnpm and npm caches persist
across runs, and Docker Hub pulls go through a local cache.

## How commands are passed

After `--`, **one argument is a shell command as written**:
`pr2video sandbox exec -- 'npm ci && npm run build'`. **Several arguments are an argv**, quoted for
you: `pr2video sandbox exec -- sh -c 'echo one; echo two'`. Commands run as root under `bash -l`,
in `/work/head` unless you pass `--cwd`.

The host repository is **not** mounted in the sandbox: `/work/head` and `/work/base` are their own
checkouts. To bring in a file you wrote (a seed script, a fixture), copy it:
`pr2video sandbox cp --record ./seed.cjs /opt/seed/seed.cjs`, then record a step that runs it.
`--record` keeps a copy in the run and journals the copy, so replay brings the same file. Keep it out
of the repository's working tree and under `.pr2video/<run>/` on the host.

## How to work

1. Read how the project runs before running anything: `README`, `package.json` scripts,
   `docker-compose.yml`, `.env.example`, CI workflows (`.github/workflows/*`), `Makefile`, `Procfile`.
2. Run each setup step with `pr2video sandbox exec --record -- <command>`. It ends by printing the
   exit code and the step's number. A step that fails is not recorded: fix it and run it again. To
   take back a step that succeeded but was wrong, `pr2video sandbox journal drop <n>`. Use `--json`
   when you need the exit code and output; the full output of every command is in
   `.pr2video/<run>/logs/`.
3. Start servers with `pr2video sandbox start <name> --port <port> --record -- <command>`. It waits
   until the port answers with a status below 500, and fails early if the process exits; then read
   `pr2video sandbox logs <name>`. If a temporary server answers first (a migration screen), add
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
own API or a script, as a recorded step after the server is up, so the base gets the same data.
Read the app's tests (e2e helpers, fixtures) for how they create users and records; they are
usually the shortest path. First-run setup wizards (create the admin account) are often an API call.

## Secrets and outside services

The app can reach the internet from the sandbox (it needs it to install packages), so it may fetch
favicons, fonts or previews from other sites while you record. Prefer settings that turn such
fetches off, and never give it real accounts or keys.


Never invent real credentials. Use the project's example values, a local double (a Postgres in
Docker instead of a hosted one), or ask the user. If the app cannot start without an outside
service you cannot stand in for, stop and say which one.
