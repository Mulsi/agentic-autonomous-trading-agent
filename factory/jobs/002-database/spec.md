# S0b Database

## Goal

Add the database and research foundations that S0a left out:

- Postgres 16 in Docker, started by `make db-up`.
- Drizzle and drizzle-kit wired to an empty first migration, which `make db-up` applies.
- A `research/` Python skeleton managed by uv, kept outside the TypeScript build and test run.

With this job, every command in the S0 "Done when" exists and passes on a clean checkout.

The job contains no trading logic, no tables, and no database connection from the app.

## Plan references

- `SLICE_1_PLAN.md`: §2 Ops row (Postgres in Docker, no Redis), D1, D2 (PostgreSQL 16 in Docker, Drizzle ORM with drizzle-kit migrations, `pg` driver, `numeric` read as string), D11 (Postgres in Docker, crash loudly), D12 (UTC), D13 (Python 3.12 with `uv`, only in `research/`, offline, reads Postgres, never writes trading tables), §4 module layout (`src/db/`, `research/`), §5 preamble, §5 S0 bullets 2 and 3 plus "Done when", §7 (tables, all deferred here).
- Master plan Part I: §32 (no secrets in logs).
- Master plan Part II: §2 (top-level `docker-compose.yml` and `research/`), §3 (environment, narrowed by S0), §4 (schema, deferred), §24 preamble, Phase 1 ("Docker skeleton") and Phase 3 (database, narrowed by S0).
- `CLAUDE.md`: "Layout and commands", "Known gaps between plan and repo".
- `factory/backlog.md`: item S0b. S0c must merge before the app first connects to the database. S0d owns the lockfile re-resolve.
- `factory/jobs/001-repo-foundation/`: `spec.md` (D1 settlement, `make db-up` deferred to S0b), `build.md` (align the `.env.example` placeholder with `docker-compose.yml`), `decision.md` item 6.

## Scope

### In

**Postgres in Docker: `docker-compose.yml` at the repo root**
- Exactly one service, running the official `postgres` image tagged on major version 16. There are no other services: no Redis (D2) and no admin UI.
- The port is published on `127.0.0.1` only. The host port is the builder's choice, and `.env.example` must match it.
- Credentials are fixed local-development values written in the file. They are reachable only on loopback, and they are not a secret in the plan's sense (§1: the only secret is `ANTHROPIC_API_KEY`).
- The file has no `${...}` interpolation and no `env_file:`. Compose reads a repo-root `.env` on its own, so this rule keeps the user's `.env` out of the container. It also makes a clean checkout behave the same as the main one.
- Data lives in a named volume. The service has a `pg_isready` healthcheck.
- The server time zone is UTC.

**Drizzle, in the app folder**
- Add `drizzle-orm` and `pg` as dependencies, and `drizzle-kit` and `@types/pg` as dev dependencies. Use current stable releases, not prereleases.
- Add them with `pnpm add` and leave existing resolutions alone. Re-resolving the lockfile belongs to S0d.
- If a new package needs its install script, name the package and the script in `build.md`, and allow only that package. Never enable install scripts for all packages.
- `drizzle.config.ts` at the app root:
  - `postgresql` dialect
  - schema `./src/db/schema.ts`
  - output `./src/db/migrations`
  - URL from `process.env.DATABASE_URL` only. There is no dotenv, and nothing opens `.env`.
- `src/db/schema.ts` declares no tables yet. A one-line comment says that each table arrives with the milestone that first uses it (§7).
- The first migration is empty. Create it with drizzle-kit's custom-migration option and commit it under `src/db/migrations/` with its journal and snapshot.
  - The gate protects `/src/db/migrations/`, so every later schema change needs a human.
  - If the migrator rejects a file with no statements, the file may hold one no-op such as `SELECT 1;`. Criterion 13 checks what the migration does, not its text.
- Package scripts:
  - `db:generate` runs `drizzle-kit generate`.
  - `db:migrate` applies the committed migrations to the database named by `DATABASE_URL` in the process environment. It fails when that variable is unset.
  - `test:db` runs the DB tests.
- No script uses `drizzle-kit push`. Schema changes go through committed migrations only, because `push` would skip the protected migrations path.

**`make db-up` in the root `Makefile`**
- It works under the same conditions as the existing targets: a non-interactive shell, `factory/env.sh` sourced, dependencies installed by the target itself, a repo path containing spaces, and a clean checkout with no `.env`.
- It must find `docker` even when `docker` is not on `PATH`. Docker Desktop is installed at `/Applications/Docker.app`, and its CLI can be missing from a non-interactive shell's `PATH`, just like `node`.
- It starts Postgres, waits until the service is healthy, then runs `pnpm db:migrate` against the compose database.
- Running it again is safe.
- Any failure exits non-zero (D11). No step is masked with `|| true` or similar.
- It never reads `.env`.

**DB tests**
- Add a `test:db` script, a vitest config for it, and `*.db-spec.ts` files under `test/db/`.
  - `pnpm test` and `pnpm test:e2e` do not collect these files, so the gate needs no database.
  - The files must stay under `test/`, because the gate's `TEST_FILES` pattern does not match a `.db-spec.ts` file anywhere else.
- Each DB test creates a throwaway database whose name has a test prefix, runs `pnpm db:migrate` against it as a child process, checks the result, and drops it.
  - A small guard refuses to create, migrate or drop any database without the prefix.
  - Later DB tests reuse this guard, so no test run can touch the `trader` database or a paper-run ledger.
- Connection details come from committed files (fixtures, or `docker-compose.yml` and `.env.example`), never from `.env`.
- `isSpecFile` in `test/fixtures/repo.ts` learns the new suffix, and `tests.json` lists the new files.

**`research/` at the repo root**
- `pyproject.toml` for uv: a `[project]` table, Python 3.12 only, no dependencies yet.
- `.python-version` (`3.12`) and `uv.lock`.
- `notebooks/` and `reports/`, each with a tracked placeholder file.
- `README.md` stating the D13 boundary:
  - offline only
  - reads from Postgres
  - never writes to trading tables
  - never in the live decision path
  - outputs are data, and they affect trading only after the TypeScript replay reproduces them
- `.gitignore` entries for `.venv/`, `__pycache__/` and `.ipynb_checkpoints/`.
- `research/` stays out of `package.json` scripts, the TypeScript, ESLint and vitest configs, and the `make test`, `make lint` and `make typecheck` targets.

**Repo files**
- `progress.md`:
  - marks S0b done and names S0c as next
  - says S0c and S0d remain open under S0
  - describes `make db-up`, `pnpm db:migrate`, `pnpm test:db` and `research/`
- The progress assertions in `test/unit/tooling/repo-files.spec.ts` ("names S0b as next" and the S0b-unchecked check) move forward to match. The file they test changes on purpose, so this removes no coverage and is not editing a test to go green.
- `tests.json` lists every new spec file.
- `build.md` holds proposed `CLAUDE.md` text for the command block, adding `make db-up`, `pnpm db:migrate` and `pnpm test:db`. `CLAUDE.md` on `main` already has S0a's text (eslint, `pnpm typecheck`, "Settled by S0a"), so write the proposal as a change to that current file.

### Where the plan and the repo disagree

**D1, location.** This job follows the S0a settlement. `docker-compose.yml` and `research/` go at the repo root. `drizzle.config.ts`, `src/db/schema.ts` and `src/db/migrations/` go in `local-trading-agent-backend/`, which matches §4 and the gate's protected pattern `/src/db/migrations/`.

**Database connection.** Master Phase 3 asks for an async connection, the full schema, indexes and migration tests. §4 lists `src/db/client.ts`. S0 narrows this to "Drizzle + drizzle-kit wired with an empty first migration". The backlog adds that S0c, the log redaction hardening, must merge before the app first connects to the database: the S0a security review found that driver errors are the likely leak.

So this job has:
- no `client.ts`
- no Nest database module
- no pool
- no connection at boot

The only connections come from `db:migrate`, which is the drizzle-kit CLI and not the app's logger, and from the DB tests. The first job that stores data adds the client, and that job comes after S0c.

**Tables.** §7 and master §4 list the tables. S0 asks for an empty first migration, so every table, index and enum arrives with the job that first uses it.

**Python packaging.** Master §2 puts `pyproject.toml` at the top level and `research/datasets/` in the tree. D13 keeps Python inside `research/`, so there is no root `pyproject.toml`. §4 lists only `notebooks/` and `reports/`, and D13 has research read from Postgres, so there is no `datasets/`.

**`.env.example`.** S0a's placeholder is `postgresql://trader:change-me@localhost:5432/trader`. It must match the compose credentials and port. Changing it is allowed, and it is a protected path.

**`progress.md`.** It says the S0 "Done when" applies once S0b merges. The backlog has since added S0c and S0d under S0. S0b delivers the last "Done when" command, and `progress.md` should say that S0c and S0d are still open.

### Out

- Every table, index, enum or column from master §4 or slice §7.
- `src/db/client.ts`, a Nest database module, any pool or client in `src/`, and any database connection from the app at boot or at runtime. These wait for S0c.
- Running migrations from the app at startup.
- Any target or script that drops the database or deletes the volume, such as `db-reset` or `docker compose down -v`.
- Restart policy and surviving a reboot: S11.
- Research dependencies (pandas, Jupyter, a Postgres driver), Python lint and test tooling, and a read-only database role for research: the first research task.
- Redis and BullMQ: W2.
- Lockfile refresh, Express, `multer`, `@nestjs/mau`: S0d. Log redaction: S0c.
- Any change to `src/config/`. The `DATABASE_URL` schema already accepts the compose URL. If a change there seems necessary, stop and say so in `build.md`.
- Any change to `factory/`, `.claude/`, `CLAUDE.md`, `SLICE_1_PLAN.md` or the master plan.

### Builder environment

- **Docker.**
  - Docker Desktop is installed. Starting it is fine. Do not install Docker, change its settings, or use Podman instead.
  - Never stop or remove a container, volume or process you did not create. If the chosen host port is taken, pick another and update `.env.example`.
  - Run one compose project at a time.
  - Remove each scratch clone's compose project, including its volume, when you are done with it. Never run `down -v` from the main checkout or for a project you did not create.
- **uv.** If `uv` is not installed, do not install it. Leave `uv.lock` out, mark criterion 26 and the lockfile part of criterion 22 as not run in `build.md`, and a human runs `uv lock` before merge. Never write `uv.lock` by hand.
- Never read `.env`. Tests and scripts use committed values only.

### Stop conditions

- **drizzle-kit cannot run.** If drizzle-kit cannot load the config, or cannot run `generate` or `migrate`, on Node 26, TypeScript 6 and an ESM package, stop and say so in `build.md`. Do not downgrade Node or TypeScript, switch ORM, or write the migration journal by hand.
- **No Docker daemon.** If no Docker daemon can be reached, build everything else, mark the `db` and Docker `shell` criteria as not run, and stop. Do not mock Postgres or use another database.

### Gate constraints

- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint` and `pnpm build` must pass under those exact names. Commit `pnpm-lock.yaml`.
- The gate does not run `pnpm typecheck`, `pnpm test:e2e`, `pnpm test:db`, `make`, `docker` or `uv`. Run them yourself and paste their output into `build.md`.
- Tripwires scan the added lines of `docker-compose.yml`, the `Makefile`, `drizzle.config.ts`, the SQL and JSON migration files, `pyproject.toml`, `.gitignore` and `.env.example`. None of them may contain a Binance key name, `withdraw`, `sk-ant-`, or a quoted forbidden mode near `mode` or `TRADER_MODE`. The compose file sets only Postgres variables.
- `.skip(`, `.only(`, `.todo(`, `xit(` and `fit(` fail the gate.
- Expect `NEEDS_HUMAN: yes`, because `src/db/migrations/` is protected, and so is `.env.example` if it changes.

## Acceptance criteria

Each criterion is tagged with how it is proved:
- `unit` runs in `pnpm test`, with no database.
- `db` runs in `pnpm test:db` against the compose Postgres. The builder pastes the output into `build.md`.
- `e2e` runs in `pnpm build && pnpm test:e2e`.
- `shell` is a command run in the worktree or a scratch clone, with its output pasted into `build.md`.

**Postgres in Docker**

1. `unit` `docker-compose.yml` exists at the repo root and defines exactly one service. Its image is `postgres` tagged on major version 16: `16`, or `16.` followed by a minor version or a variant. It is never `latest`, untagged, or another major version.
2. `unit` The service publishes its port on `127.0.0.1` only. No port mapping lacks a host IP, and none uses `0.0.0.0` or `::`.
3. `unit` The data directory is a named volume declared under top-level `volumes:`, and the service has a healthcheck that runs `pg_isready`.
4. `unit` `docker-compose.yml` contains no `${` and no `env_file:` key.
5. `unit` The user, password, database name and published host port in `docker-compose.yml` equal those in the `DATABASE_URL` of `.env.example`, and in the URL that `make db-up` passes to `pnpm db:migrate`. `.env.example` still has exactly the three S0a keys and still passes S0a's tests.
6. `db` The compose server reports `server_version_num` ≥ 160000 and < 170000, and `SHOW timezone` returns `UTC` or `Etc/UTC`.

**Drizzle**

7. `unit` `package.json` lists `drizzle-orm` and `pg` in `dependencies`, and `drizzle-kit` in `devDependencies`. Neither their ranges nor their locked versions are prereleases. `package.json` still has no `dotenv`.
8. `unit` `drizzle.config.ts` in the app folder uses the `postgresql` dialect, schema `./src/db/schema.ts` and output `./src/db/migrations`, and reads the URL from `process.env.DATABASE_URL`. It contains no `dotenv`, `loadEnvFile`, `env-file` or `.env` path.
9. `unit` `src/db/schema.ts` exists and declares no database object. It contains none of `pgTable`, `pgEnum`, `pgSchema`, `pgView`, `pgMaterializedView`, `pgSequence`, `pgRole` or `pgPolicy`.
10. `unit` `src/db/migrations/` holds exactly one `.sql` file. `meta/_journal.json` has exactly one entry, its tag names that file, and a matching snapshot exists. The `.sql` file contains none of `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `GRANT` or `TRUNCATE`.
11. `shell` In the app folder, `pnpm db:generate` reports no schema changes and leaves `git status` clean, and `pnpm exec drizzle-kit check` exits 0.
12. `unit` `package.json` has `db:generate`, `db:migrate` and `test:db` scripts. No script contains `drizzle-kit push`, and no `db:*` or `test:db` script references `.env`.

**Applying migrations**

13. `db` A test does the following:
    - creates a throwaway database whose name has the test prefix
    - runs `pnpm db:migrate` against it as a child process, with a fixture `DATABASE_URL`
    - finds exactly one row in drizzle's migrations table
    - finds no table, view, sequence, function or type in any non-system schema other than drizzle's own bookkeeping schema
    - runs `pnpm db:migrate` again, sees exit 0, and still finds exactly one row
    - drops the database at the end, including when an assertion fails
14. `db` `pnpm db:migrate` exits non-zero when `DATABASE_URL` is unset, when the password is wrong, and when no server listens on the port. The wrong password is a sentinel string, and it appears in neither stdout nor stderr of any of these runs.
15. `unit` The DB test guard refuses to create, migrate or drop a database whose name lacks the test prefix. A unit test shows that it rejects `trader` and `postgres`.
16. `shell` With the compose database stopped, `pnpm test` exits 0. `vitest list` shows that `pnpm test` collects no `*.db-spec.ts` file and that `pnpm test:db` collects only `*.db-spec.ts` files.

**The app stays unconnected**

17. `unit` No non-spec file under `src/` imports `pg` or `drizzle-orm/node-postgres`, or contains `new Pool(`, `new Client(` or `drizzle(`. `AppModule` still imports only `ConfigModule` and `LoggerModule`.
18. `e2e` The existing e2e suite passes with no Postgres reachable. With fixture env, the built app boots and exits 0 by itself.

**`make db-up`**

19. `shell` Set up a fresh `git clone` in a path containing a space, with no `node_modules` and no `.env`, in a shell started with `env -i HOME="$HOME" PATH=/usr/bin:/bin`, with Docker Desktop running. Then:
    - `make db-up` exits 0.
    - Postgres 16 reports healthy.
    - The `trader` database has exactly one row in drizzle's migrations table.
    - A second `make db-up` exits 0, and there is still exactly one row.
    - In the same clone, `make test`, `make lint` and `make typecheck` each exit 0.

    This is the S0 "Done when".
20. `shell` In that clone, run `docker compose down` without `-v`, then `make db-up`. The same single migration row remains, with the same `created_at`.
21. `shell` With Docker unreachable (for example `DOCKER_HOST=unix:///nonexistent.sock`), `make db-up` exits non-zero within 60 seconds, and its output names Docker.

**`research/`**

22. `unit` `research/pyproject.toml` has a `[project]` table whose `requires-python` admits only 3.12, and its `dependencies` is empty or absent. `research/.python-version` contains `3.12`. `research/uv.lock` exists. `research/notebooks/` and `research/reports/` each hold a tracked placeholder.
23. `unit` Outside `research/`, the repo has no `*.py`, `*.ipynb`, `pyproject.toml`, `uv.lock`, `requirements*.txt` or `.python-version` file. The check ignores `node_modules/`, `.git/` and `.worktrees/`.
24. `unit` Nothing in the TypeScript toolchain mentions `research`, `uv` or `python`:
    - no script in `package.json`
    - none of the Makefile's `test`, `lint`, `typecheck` or `db-up` recipes

    Also, none of `tsconfig.json`, `eslint.config.mjs` or any vitest config refers to `research`.
25. `unit` `research/README.md` states each D13 boundary: offline only, reads from Postgres, never writes to trading tables, never in the live decision path, and outputs affect trading only after the TypeScript replay reproduces them.
26. `shell` In `research/`, `uv lock --locked` exits 0, and `uv run python -c 'import sys; print(sys.version_info[:2])'` prints `(3, 12)`. Afterwards `git status --porcelain` is empty, and `git check-ignore` matches `research/.venv/`, a `__pycache__/` folder and an `.ipynb_checkpoints/` folder.

**Repo files**

27. `unit` `isSpecFile` treats `*.db-spec.ts` as a spec file, every DB spec lives under `test/`, and `tests.json` lists every spec file exactly once, DB specs included.
28. `unit` `progress.md`:
    - marks S0a and S0b done
    - names S0c as next
    - says S0c and S0d remain open under S0
    - mentions `make db-up` and `research/`
29. `shell` `build.md` contains proposed `CLAUDE.md` text that adds `make db-up`, `pnpm db:migrate` and `pnpm test:db` to the command block as it stands on `main`, keeping the lines already there.

**Job boundaries**

30. `shell` `pnpm typecheck`, `pnpm build && pnpm test:e2e` and `pnpm test:db` each exit 0, and their output is pasted into `build.md`.
31. `shell` Every direct dependency that exists on `main` resolves to the same version on this branch, according to `pnpm list --depth 0` before and after. In particular, `typescript` stays at 6.0.3 and `@nestjs/core` at 12.2.0.
32. `shell` `git diff --name-only main...HEAD` lists nothing under `factory/`, `.claude/` or `src/config/`, and lists neither `CLAUDE.md` nor a plan document. `git diff --name-status --diff-filter=D main...HEAD` lists no spec file.
33. `shell` `factory/gate.sh 002-database` reports `GATE: PASS` and `NEEDS_HUMAN: yes`. The orchestrator runs this.
34. `[human]` A human:
    - reads `src/db/migrations/` and `drizzle.config.ts`
    - accepts the local development credentials in `docker-compose.yml` and `.env.example`
    - confirms that the database client stays deferred until after S0c
    - applies the `CLAUDE.md` text from `build.md`

## Rules that apply

- **No real orders and no Binance keys.** The compose file, `.env.example` and the Makefile add no key and no mode variable. The only secret is still `ANTHROPIC_API_KEY`.
- **Secrets never logged** (S0, master §32). `DATABASE_URL` embeds a password, so `db:migrate` must not echo it, even on failure (criterion 14).
- **Factory agents never read `.env`.** Neither drizzle-kit, the Makefile, compose interpolation nor any test may read it.
- **Invalid data is never silently used, and failures are loud (D11).** A failed migration or an unreachable Docker exits non-zero. Nothing is masked.
- **UTC everywhere.** The database time zone is UTC (criterion 6).
- **One implementation (D13).** Python lives only in `research/`. It runs offline, it is never in the live decision path, and it never writes trading tables. No logic is duplicated in Python.
- **No Redis in slice 1 (D2).** The compose file has Postgres only.
- **Claude cannot bypass safety.** Schema changes go only through committed migrations under the protected path, with no `drizzle-kit push`, so a human reviews every change to the tables that later hold risk events, the 48-entry counter and the kill switch.
- **Never delete or skip a test to go green.** The `progress.md` assertions move forward to match the file. They are not removed. The gate must not need a database, so DB tests go in their own suite rather than being skipped.
- **ESM.** Relative imports end in `.js`.

The entry gate, the 48-entry limit, exits, EV and `Decimal` rules are not touched, because this job adds no tables and no trading logic. The `pg` driver returns `numeric` as a string by default, and nothing in this job changes that.

## Open decisions

None. No `SLICE_1_PLAN` §11 item affects this job.

These spec-level choices are not §11 items. Criterion 34 puts them in front of a human, and the protected migrations path sends this job to needs-human in any case:

- Fixed local-development credentials in `docker-compose.yml`, bound to loopback.
- No database client in the app until S0c merges.
- `make db-up` both starts Postgres and applies migrations.
