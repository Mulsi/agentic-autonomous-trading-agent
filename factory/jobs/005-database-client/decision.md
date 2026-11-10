ESCALATE

## Why

The work looks sound. All four round-1 reviews (code, quant, risk, security) say PASS with no blocking findings. `gate.md` reports `GATE: PASS` for install, test, lint and build, with no tripwire hits and no deleted or skipped test. The diff stays in scope: no `factory/`, `.claude/`, `CLAUDE.md`, plan, `docker-compose.yml` or `Makefile` change, and no change to dependencies or the lockfile. I read the production diff and found no fail-open path. `decideIdentity` returns `VERIFIED` from one place only, on an exact match against a single row. `blocksEntries` is `status !== 'VERIFIED'`. No `setTypeParser` call was added, and money columns stay string `numeric`.

It still cannot be approved automatically, for four separate reasons:

1. **`gate.md` says `NEEDS_HUMAN: yes`.** The diff touches protected paths: `.env.example`, four files under `src/config/`, three new migrations under `src/db/migrations/`, and their snapshots and journal.
2. **The spec has a `[human]` criterion.** Criterion 39 asks a person to read the protected changes, accept `research_reader`, confirm the Open decisions, do the post-merge `DATABASE_IDENTITY` setup and apply the `CLAUDE.md` text.
3. **The spec has six Open decisions** that need a human to confirm them. They include a third settings key that departs from §5 S0's two-key `.env.example`, and a fixed research password committed in a migration.
4. **It touches things a person should sign off.** These are a schema migration that creates a server-wide `LOGIN` role, the database-identity check that S7a will use as a hard entry gate (it protects the 48-entry counter and the kill switch), and the money and time column conventions.

Two reviews raised concerns that are real, though not blockers. The human should see them rather than have them waved through (see items 4 and 5 below).

## What a human should check

1. **Protected files (criterion 39).**
   - `local-trading-agent-backend/src/db/migrations/0001_database_identity.sql`: singleton boolean PK with a CHECK, `marker uuid`, `created_at timestamptz`.
   - `0002_database_identity_marker.sql`: one `INSERT ... gen_random_uuid()`.
   - `0003_research_reader.sql`: the role is created idempotently, the `ALTER ROLE` uses the fixed password `research-local-dev-only`, and the grants are CONNECT, USAGE and SELECT plus default privileges.
   - `meta/0001-0003_snapshot.json` and `meta/_journal.json`.
   - `src/config/settings.ts`, `secrets.ts` (`databaseTarget`), `config.module.ts` (`recordBootSecrets`) and the new `boot-output.ts`.
   - `.env.example`: one new line, `DATABASE_IDENTITY=`.
2. **Accept or reject the Open decisions in spec.md.**
   - The third settings key `DATABASE_IDENTITY`.
   - Postgres generates the marker.
   - A failed connect fails the boot, while an identity UNKNOWN never does.
   - The fixed research password, created on every server the migrations run against.
   - The `_ms` suffix rule for number-mode `bigint`.
   - `pnpm test:e2e` now needs the compose Postgres.
3. **Gate coverage.** The gate did not run `pnpm test:db`, `pnpm test:e2e` or `pnpm typecheck`. build.md pastes their passing output (58 db tests, 36 e2e tests). If you want independent evidence for the boot-scrub and identity criteria (10, 11 and 13), re-run `make db-up`, then `pnpm build && pnpm test:e2e && pnpm test:db` in the worktree.
4. **Risk review item 1: the setup steps can re-pin a stand-in ledger.** The steps in `progress.md` (and in build.md "For the human" step 4) would set `DATABASE_IDENTITY` to the new database's marker after a folder rename or a lost volume, because every step passes there too. The ledger would then read `VERIFIED` with zero entries and no kill switch. That is exactly the case this job exists to catch. Add a sentence before or right after merge: the setup is for a database's first run only, and a later `mismatch` or `missing_marker` on a checkout that was `VERIFIED` is an incident (Rule 9). Never copy the marker from a `mismatch` line to clear it.
5. **Risk review item 2: a dropped connection during the marker read crashes the boot.** It does not become `unreadable`. `src/db/client.ts` attaches no `error` listener to the checked-out client during `readMarker`, so a socket reset mid-SELECT is an uncaught exception that exits 1. This fails closed, so it is not a safety hole. But it contradicts the spec's "unreadable ... never fails the boot", and it is untested. So is the marker-read `query_timeout` (risk item 3). Decide whether to fix it now or record it as a known deviation for S11a and S12.
6. **Hand-offs to note for later jobs.**
   - S7b's risk-approval transaction should re-read `database_identity.marker` in the same snapshot as the counter (risk item 4).
   - The schema scan is a deny-list that does not cover `jsonb`, arrays or integer types (quant 2, risk 6).
   - `?sslmode=require` in `DATABASE_URL` is silently ignored (security 1).
   - Take the research password out of the migration before any non-local Postgres (security 2).
7. **The pnpm store.** The builder's first M8 mutation run downloaded `ccxt@4.5.92` and `bufferutil@4.1.0` into your global pnpm store. Their build scripts were blocked and the worktree was cleaned. Consider `pnpm store prune`, and consider `verifyDepsBeforeRun: error` (or running vitest directly) for future mutations that touch `package.json`.
8. **After merge, in the main checkout (criterion 39).**
   - Run `make db-up` and the app once.
   - Confirm with `docker compose ps` that the main checkout's own container is answering on `127.0.0.1:55432`.
   - Copy the marker from the identity line into `DATABASE_IDENTITY` in `.env`.
   - Run the app again and confirm it logs `VERIFIED`.
   - Apply the proposed `CLAUDE.md` line: `pnpm test:e2e    # run pnpm build and make db-up first`.
