ESCALATE

## Why

The work looks sound. It escalates only because two of the approval conditions fail by design:

- **The gate reports `GATE: PASS` with `NEEDS_HUMAN: yes`.** The diff touches protected paths: `.env.example`, `src/db/migrations/0000_init.sql`, `meta/_journal.json` and `meta/0000_snapshot.json`. The spec predicted this (criterion 33).
- **The spec has a `[human]` criterion.** Criterion 34 asks a person to read the migration and the drizzle config, accept the local credentials, confirm that the DB client stays deferred, and apply the `CLAUDE.md` text. No agent can sign that off.

What I checked, without finding a blocker:

- **Scope.** There are 35 changed paths. None is under `factory/`, `.claude/` or `src/config/`, and neither `CLAUDE.md` nor a plan document changed. No spec file was deleted. Under `src/`, the only changes are `src/db/schema.ts` (a comment and `export {}`) and the empty migration. There is no client, no pool and no Nest DB module, so the app still opens no database connection, and an e2e case counts 0 connections.
- **The migration** is drizzle-kit's comment line only. The journal has one entry, `0000_init`, and the snapshot is empty. No script uses `drizzle-kit push`.
- **Safety rules.** `TRADER_MODE=paper` is unchanged. There is no Binance key, no `withdraw` and no new mode variable. Compose has no interpolation and no `env_file`, and `make db-up` passes `--env-file /dev/null`. drizzle-kit's bundled dotenv is neutralised with `DOTENV_CONFIG_PATH=/dev/null`, and a real-process test proves it. Failures are loud: `set -eo pipefail` with nothing masked. The DB test guard, `^trader_test_[a-z0-9_]{1,40}$`, also refuses query-string URLs, so no test can create, migrate or drop `trader` or `postgres`.
- **Dependencies.** All four are stable and were added with `pnpm add`. Every direct version from `main` is unchanged, including `typescript` 6.0.3 and `@nestjs/core` 12.2.0. No install script runs: esbuild's is denied in a new `pnpm-workspace.yaml`.
- **Evidence.** `build.md` has shell output for criteria 11, 16, 18 to 21, 26 and 30 to 32. That includes the fresh-clone `env -i` run of `make db-up`, `make test`, `make lint` and `make typecheck`, run twice, and the Docker-unreachable run. Some of this output is from `febb4c6`. After `d7bce7d`, which changes only a comment and adds one guard test, the builder reran `pnpm test`, `lint`, `build` and `test:db`.
- **Reviews.** All four reviews pass. Their advisories are real, but they concern later jobs, not defects in this one. They are listed below so they reach the backlog.
- **Risk limits, strategy and money.** Nothing touches risk limits, strategy parameters, money handling or the entry, exit, EV or 48-entry logic.

## What a human should check

1. **Criterion 34.**
   - **Read the migration and the config.** Read `local-trading-agent-backend/src/db/migrations/` and `local-trading-agent-backend/drizzle.config.ts`. The SQL file holds only `-- Custom SQL migration file, put your code below! --`.
   - **Accept the local credentials:** user `trader`, password `local-dev-only`, database `trader`, published on `127.0.0.1:55432`. They appear in `docker-compose.yml`, the `Makefile` and `.env.example`.
   - **Confirm that the DB client stays deferred until S0c merges.**
   - **Apply the `CLAUDE.md` command block** from `build.md`, under "Proposed CLAUDE.md text". Consider also adding the optional sentence that schema changes go through `pnpm db:generate` and committed migrations, never `drizzle-kit push`. The security review adds a related suggestion: run drizzle-kit only through the `db:*` scripts, because a bare `pnpm exec drizzle-kit ...` still loads an app-folder `.env`.
2. **The `.env.example` change.** It is protected. The URL went from `trader:change-me@localhost:5432` to `trader:local-dev-only@127.0.0.1:55432`. Update your own `.env` to match when you next use it.
3. **The new `local-trading-agent-backend/pnpm-workspace.yaml`.** It contains `allowBuilds: esbuild: false`, which denies an install script rather than allowing one. Confirm you are happy for this file to exist before S0d re-resolves the lockfile. `esbuild@0.18.20`, a dev-only dependency pulled in through drizzle-kit, has a known dev-server advisory (GHSA-67mh-4wv8-2f99). `pnpm audit` will flag it, and S0d can weigh an override.
4. **Reviewer advisories to put in the backlog.** None blocks this job.
   - **The gate never runs `pnpm test:db`** (risk review, item 1). Before S7b, the 48-entry counter's transactional, concurrency and window proofs must run in a suite the gate executes. Otherwise a regression that lets a 49th entry through could still get `GATE: PASS`.
   - **The ledger has no identity** (risk review, item 2). Every checkout publishes on `127.0.0.1:55432`, and each compose volume is named after its folder. A still-running worktree's database, or an empty volume after the folder is renamed, could silently stand in for the real ledger: the counter would read 0, and a latched kill switch would not be seen. The job that adds `src/db/client.ts` should check a stored ledger identity at boot, and treat a mismatch as UNKNOWN, which blocks entries.
   - **Research runs as a superuser** (risk review, item 4). The only role is `trader`, a superuser. A read-only research role must exist before any research code connects.
   - **Money and time columns.** When tables arrive, money columns must be `numeric` in string mode, never `mode: 'number'`, `real` or `doublePrecision`. Time columns should be `timestamptz` or epoch milliseconds (quant review). A malformed-URL error can carry the full `DATABASE_URL` in its `input` property, and S0c or the client job should handle that (security review, note 5).
