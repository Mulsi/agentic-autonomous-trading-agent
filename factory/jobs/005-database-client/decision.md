ESCALATE

## Why

Round 2 did what the human note asked, and nothing more. Commit `6e22bf7` sits on top of `c0c087a`. Its source changes are small, and I read them in the diff:

- `src/db/client.ts` attaches an `error` listener only for the marker read. It releases the client first and then removes the listener.
- `src/config/settings.ts` adds `.refine(!/[?#]/)` on `DATABASE_URL`.
- `pnpm-workspace.yaml` adds `verifyDepsBeforeRun: error`.
- The rest is tests, fixtures, `progress.md` and `tests.json`.

The work itself looks sound:

- All four round-2 reviews (code, quant, risk, security) say PASS with no blocking findings, and each checked all five items.
- Item 2 fails closed. The swallowed `error` event is not a swallowed failure: the query still rejects, so the result is UNKNOWN `unreadable`, never `VERIFIED`. A mutation in build.md shows the unit test fails without the listener.
- Item 4 only refuses more input. The S0d generator was reclassified, not narrowed, and its acceptance threshold is unchanged.
- Only one test name was removed, and the new key forces the rename.
- `package.json` and the lockfile are unchanged. The diff touches nothing under `factory/` or `.claude/`, and not `CLAUDE.md`, compose or the `Makefile`.

It still cannot be approved automatically, for the same structural reasons as round 1:

1. **`gate.md` says `GATE: PASS` but `NEEDS_HUMAN: yes`.** The diff touches protected paths: `.env.example`, four files under `src/config/` (`settings.ts` changed again this round), three new migrations under `src/db/migrations/`, and their snapshots and journal.
2. **The spec has a `[human]` criterion.** Criterion 39 needs a person to read the protected changes, accept `research_reader` and its password, confirm the Open decisions, do the post-merge identity setup and apply the `CLAUDE.md` text.
3. **The spec has six Open decisions** that a human must confirm.
4. **It changes things a person should sign off.** It adds a schema migration that creates a server-wide `LOGIN` role with a fixed password. It adds the database-identity check that S7a will use as a hard entry gate, protecting the 48-entry counter and the kill switch. It sets the money and time column conventions. And it narrows which `DATABASE_URL` values the app accepts.

No review waved through a real concern this round. The carried-forward notes are hand-offs the human already deferred. They are listed below so they are not lost.

## What a human should check

1. **The round-2 changes against your note.**
   - `local-trading-agent-backend/src/db/client.ts` `readMarker`: the error listener and the release order.
   - `local-trading-agent-backend/src/config/settings.ts`: the `?`/`#` refusal. It is a protected path.
   - `local-trading-agent-backend/pnpm-workspace.yaml`: `verifyDepsBeforeRun: error`.
   - `progress.md`: the setup steps now say "first run only, never copy a mismatch marker".
   - `test/fixtures/database-urls.ts`: query and fragment URLs moved into a near-miss family.
2. **Protected files (criterion 39), unchanged since round 1 except `settings.ts`.**
   - `0001_database_identity.sql`, `0002_database_identity_marker.sql` and `0003_research_reader.sql` (fixed password `research-local-dev-only`, with CONNECT, USAGE and SELECT plus default privileges).
   - `meta/` snapshots and `_journal.json`.
   - `src/config/secrets.ts`, `config.module.ts` and `boot-output.ts`.
   - `.env.example`, which gains `DATABASE_IDENTITY=`.
3. **The six Open decisions in spec.md.**
   - The third settings key.
   - Postgres generates the marker.
   - A failed connect fails the boot, while an identity UNKNOWN never does.
   - The fixed research password, created on every server the migrations run against.
   - The `_ms` suffix rule.
   - `pnpm test:e2e` now needs the compose Postgres.
4. **Gate coverage.** The gate did not run `pnpm test:db`, `pnpm test:e2e` or `pnpm typecheck`. Build.md pastes passing output at `6e22bf7`: 577 unit, 40 e2e and 59 db tests. The code reviewer did not run the db or e2e suites. If you want independent evidence, run `make db-up` and then `pnpm build && pnpm test:e2e && pnpm test:db` in the worktree.
5. **A side effect on your machine.** Docker Desktop was not running when round 2 started. The builder started it, then could not quit it, and says it is still running. Quit it by hand if you want it off. Your global pnpm store also still holds the round-1 `ccxt@4.5.92` and `bufferutil@4.1.0` tarballs, so consider `pnpm store prune`.
6. **Hand-offs for later specs. None blocks this merge, but none is closed.**
   - There is no pool-level `error` listener (risk 1, security 3). Once the process stays up (S7b or S11a), an idle-socket loss will crash it and every in-process exit with it. The job that keeps the process running should log the error scrubbed and mark DB health UNKNOWN.
   - S7b's risk-approval transaction should re-read `database_identity.marker` in the same snapshot as the counter and the kill switch (round-1 risk item 4).
   - The schema scan does not cover `jsonb`, arrays or the integer types (quant).
   - Take the research password out of the migration before any non-local Postgres.
   - The `unreadable` identity line carries no SQLSTATE.
   - `tests.json:808` has stale `covers` text.
7. **After merge, in the main checkout (criterion 39).**
   - Run `make db-up` and the app once.
   - Confirm with `docker compose ps` that this checkout's own container answers on `127.0.0.1:55432`.
   - On this first run only, copy the marker from the identity line into `DATABASE_IDENTITY` in `.env`.
   - Run the app again and confirm `VERIFIED`.
   - Apply the proposed `CLAUDE.md` line: `pnpm test:e2e    # run pnpm build and make db-up first`.
