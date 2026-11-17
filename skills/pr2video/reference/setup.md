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

`pr2video sandbox down` removes the sandbox. It leaves one shared container running,
`pr2video-mirror`, the Docker Hub pull cache every sandbox uses: that is expected, not a leftover.

## How commands are passed

After `--`, **one argument is a shell command as written**:
`pr2video sandbox exec -- 'npm ci && npm run build'`. **Several arguments are an argv**, quoted for
you: `pr2video sandbox exec -- sh -c 'echo one; echo two'`. Commands run as root under `bash -l`,
in `/work/head` unless you pass `--cwd`. Quoting inside a one-argument command is yours: for SQL
or anything with nested quotes, write it to a file and `sandbox cp` it in rather than escaping.

A step may run up to 20 minutes (`--timeout <seconds>` for more). A long build or install blocks
until it ends: run it in the background of your own shell if your tool limits how long a command
may take, and wait for it to finish before recording the next step (steps are journaled in the
order they finish).

The host's project folder is only mounted read-only at `/src`, for checking out and copying; never
work there. `/work/head` and `/work/base` are the sandbox's own copies. To bring in a file you wrote (a seed script, a fixture), copy it:
`pr2video sandbox cp --record ./seed.cjs /opt/seed/seed.cjs`, then record a step that runs it.
`--record` keeps a copy in the run and journals the copy, so replay brings the same file. Keep it out
of the project's own files and under `.pr2video/<run>/` on the host, in a folder of your own such
as `.pr2video/<run>/mine/` (`files/` is where the run keeps its copies). The copy is taken when you
run `cp`: a file you change or add later needs another `cp --record`.

## Python versions

The image has Python 3.11. A project that needs another (`requires-python`, `.python-version`) gets
it from uv: install uv outside the checkout
(`curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/opt/uv sh`, then call `/opt/uv/uv`), then run the install
with the version the project's wheels exist for, e.g. `uv sync --python 3.13`, with
`UV_PYTHON_INSTALL_DIR=/opt/uv-python` so the interpreter stays outside `/work/head` and replay
reuses it. A newer Python than the project names can lack wheels for its compiled dependencies.

## Node and package-manager versions

The sandbox has Node 24, with corepack. A project that pins its package manager in
`packageManager` gets that version; one that pins it only in `engines` (`"pnpm": "12.3.4"`) gets
corepack's default, and the install may refuse it: run `corepack prepare pnpm@<version> --activate`
first, in the same recorded step as the install.

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
   until the port answers on `127.0.0.1` or `::1` with a status below 500 (a redirect counts), and
   fails early if the process exits; then read `pr2video sandbox logs <name>`. A start whose port
   never answers is not recorded. If a temporary server answers first (a migration screen), add
   `--path` with a route only the real app serves, e.g. `--path /api/health`. In a monorepo, start
   it in the app's own folder with `--cwd /work/head/<app>` (replay rewrites it to `/work/base/<app>`,
   like any path under `/work/head`); set `BROWSER=none` for a dev server that would try to open a browser.
   A `dev` script that runs through a proxy or tunnel (portless, a named host, HTTPS on a custom
   domain) will not answer on a plain port: run the tool it wraps (`vite dev --port 5173`) instead.
4. Check the app answers: `pr2video sandbox exec -- curl -sI http://localhost:<port>/`. Then
   check what it shows with `pr2video probe http://localhost:<port>/` (see scenes.md): a single-page
   app answers curl with an empty shell.

## Make every recorded step replayable

`pr2video sandbox replay` runs the recorded steps again in `/work/base` (paths under `/work/head`
are rewritten) after stopping every background process and removing every container the sandbox's
Docker runs (their volumes stay). So each recorded step must work a second time, on the base:

- Start services with `docker compose -p <project> up -d --wait`. Pin the project name with `-p`:
  compose otherwise names it after the folder (`head`, `base`), and the base then gets a second set
  of volumes, or clashes with a fixed `container_name`. For a single container,
  `docker rm -f db 2>/dev/null; docker run -d --name db ...`.
- Write config with `cp -n .env.example .env` or a heredoc, never by hand-editing in place.
- Reset the database before migrating and seeding when the base's schema differs: record a step
  that drops and recreates it.
- Wait for a database over TCP before migrating (`until psql -h localhost -p <port> -c 'select 1'; do sleep 1; done`):
  the postgres image's first start answers `pg_isready` on its socket from a temporary server that
  then restarts.
- Do not record exploration (`ls`, `cat`, `curl`): it only slows the replay.
- The image has Node 24 (with corepack), Python 3, git, curl and Docker. Install anything else the
  project needs (Go, Rust, Java, Ruby) as a recorded step, from the official release at the version
  the project names (`go.mod`, `rust-toolchain`, `.tool-versions`), or run it with `docker run` or
  the project's compose file. Keep it outside `/work/head`, e.g. `/opt/go`, so replay reuses it.
- Order matters: a reset (`docker compose -p <project> down -v`) or anything else later steps
  depend on is recorded before them. `pr2video sandbox journal drop <n>-<m>` takes back a run of
  steps to record them again in the right order.
- Run the app as its users get it when you can (a production build and `start`): a dev server adds
  its own overlay (the Next.js badge, error toasts) to every recording, and compiles each page on
  its first visit. Use the dev server when the build needs services or secrets you cannot fake.
- Record setup steps only while working on the head. Something you find you need while on the base
  (a warm-up, a missing file) belongs in the journal too: add it, then `replay` again.

## First sign-in

Many apps stop a fresh install at a first-run step: change the default password, create the first
account, finish a setup wizard. The README names the default account; the app's own end-to-end
setup (`tests/e2e/*setup*`, `playwright/`, `cypress/support/`, fixtures) shows how its tests get
past the first run, usually in a few API calls. Record those as setup steps, written so they can
run again (a second run must not fail because the password is already changed).

- An auth library that checks the request's origin (better-auth, NextAuth, Django's
  `CSRF_TRUSTED_ORIGINS`) must be configured with the origin the recorder uses, the `baseUrl` in
  `scenes.json` (`http://localhost:<port>`), not the project's usual dev host.
- Sign-up that needs a verified email: sign up through the app's API, then mark the address
  verified in the database, as a recorded seed step.
- A first-run dialog or tour that every fresh browser sees (a "What's new", a cookie banner) belongs
  in the role's sign-in steps: a click on its close button, then a wait for the page behind it.

A framework whose admin user is made interactively (Django's `createsuperuser`, Rails' console)
is made in the seed instead: e.g. a Python step
`python manage.py shell -c "from django.contrib.auth.models import User; User.objects.filter(username='demo').exists() or User.objects.create_superuser('demo', 'demo@example.com', 'demo-password')"`.

## Seeding data

Most changes only show with data: items in a list, a record to open. Create it through the app's
own API or a script, as a recorded step after the server is up, so a base gets the same data.
Read the app's tests (e2e helpers, fixtures) for how they create users and records; they are
usually the shortest path. First-run setup wizards (create the admin account) are often an API call.

- **Check that the seed wrote what you need before recording**: a `select count(*)` on the users
  and records the scenes rely on. A seed script can exit 0 and write nothing (a module that only
  exports its function), and the first sign of it is otherwise a failed sign-in.
- Seed enough history for what the page compares: "the 30 days before" needs data reaching twice
  as far back as the period shown.

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

Never invent real credentials. Sort every variable the app reads (`.env.example`, the config
module, CI workflows) into one of three kinds, and settle each before recording:

| Kind | Examples | What to do |
|---|---|---|
| **Made up**: any value of the right shape works | a session or JWT secret, an encryption key, a webhook signing secret you also sign with | Generate it in the recorded step that writes the env (`openssl rand -hex 32`) |
| **Faked**: a stand-in does the job | a database URL, a hosted Postgres or Redis, SMTP, a vendor API the tour only needs answers from | A local double (Postgres in Docker, MailHog) or a stub (below); CI workflows often hold a full set of fakes |
| **Blocker**: only a real value lets the screen show what changed | a payments key whose test-mode objects the page lists, an OAuth app the sign-in redirects to, an AI provider the feature calls | Ask the user (below) |

Most variables are made up or faked. A screen that only needs *some* answer from a service is a
stub, not a blocker; it is a blocker only when the change is in what the real service does **on
the app's own pages**. The recorder films only the app's origin: a provider's hosted page (a
payments checkout, an OAuth consent screen) is never in the tour, so a key that only leads there
unlocks nothing to film. Say so instead of offering it.

### Asking for a blocker

Ask once, for all the blockers together, before recording. Name each variable, what it unlocks
(which scenes), and give three choices:

- **Provide it**: the user runs, in their own terminal (never by pasting the value into the chat):
  `pr2video sandbox env set STRIPE_SECRET_KEY` (it asks for the value without showing it), or
  points you at a file they already have: `pr2video sandbox env import ~/app/.env STRIPE_SECRET_KEY`
  (you can run that one: it prints no value). They can also add `NAME=value` lines to
  `.pr2video/secrets.env` in an editor; the next command picks them up.
  Ask for a test-mode or sandbox key, never a live one.
- **Skip it**: leave out the scenes that need it; the tour says which and why.
- **Stub it**: film the app against a stand-in; the tour says the service's side is not real.

Without an answer (no user to ask), stub where you can, skip the rest, and say so.

### Using secrets

`pr2video sandbox env ls` lists the names set for this project (never the values); they are kept
in `.pr2video/secrets.env` for every run of the project. Every `exec` and `start` gets them as
environment variables, so recorded steps name them and never hold them:

```bash
pr2video sandbox exec --record -- 'echo "STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY" >> .env.local'
```

Output and logs show `***` in place of a value. A command, or a `cp --record` file, that holds a
value is refused: write `$NAME` instead. Never print a value (`cat .env`, `env`), and do not film
a screen that shows one. The tour's summary names the secrets the user provided (names only) and
the scenes skipped for a missing one.

### Standing in for an outside service

When a screen only settles once the app has heard back from another service (a vendor API, a
payments or search provider), stand a stub in for it rather than filming the error state:

1. Find what the app calls: the client module and the env var holding its base URL
   (`VENDOR_API_ROOT_URL`, `STRIPE_API_BASE`). The app's tests often mock the same calls: their
   fixtures are the shapes to return.
2. Write a small server that answers only those routes, under `.pr2video/<run>/mine/`, e.g.
   `stub.mjs` with `node:http`, returning canned JSON per path.
3. `pr2video sandbox cp --record .pr2video/<run>/mine/stub.mjs /opt/stub/stub.mjs`, then
   `pr2video sandbox start stub --port 4010 --record -- node /opt/stub/stub.mjs`, and point the
   env var at `http://localhost:4010` in the recorded step that writes the app's env.
4. Say in the tour's summary what is stubbed: the reviewer sees the app's side of the flow, not the
   service's.

Prefer a provider's own test mode or local emulator where there is one (Stripe's test keys need a
real account; LocalStack, the Firebase emulators and MailHog do not).

### Ids in URLs

A scene that opens `/orgs/<id>` must find the same id on the base, or its "before" is dropped (the
base ended on a different page). Seed fixed ids or slugs (`northwind-labs`), never random UUIDs,
for anything a scene's URL names.

### Seed data that differs between head and base

The base runs the base's code. Data that only the head's code can produce (a new status, a new
column's value) is not something the base can show: seeding it on both sides films the base doing
something it never does. Seed what each commit's code would have written, in one recorded step
that checks for the change, e.g. `if grep -q license_required src/checkout/progress.ts; then psql
... -f head.sql; else psql ... -f base.sql; fi`, and say so in the before scene's caption if it
matters.

### Data in a browser-only app

An app that keeps its data in the browser (a drawing tool, a local-first editor) has no API to seed
through. Use the way it opens data itself: a URL it loads from (`/#url=/demo.json`, `?file=`), an
import of a file served by the dev server (copy it into its public folder, which the framework's
config names, e.g. Vite's `publicDir`), or a first-run sample. A scene can also start by opening
the file through the app's own UI.

### Time in seeded data

A page that shows only recent rows ("the last hour", "today") empties when a replay or a re-record
runs later than the seed. Seed times relative to now (`now() - interval '5 minutes'`), never fixed
timestamps, and keep a seeding step after anything that waits long (a build).
