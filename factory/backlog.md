# Backlog

`/factory next` runs the first unchecked item. The orchestrator checks an item off only when its job merges.

Items follow `SLICE_1_PLAN.md` §5 in dependency order. The larger milestones are split so that each item fits one builder and one review. The plan's "Done when" for a milestone applies when its last item merges.

## S0 Foundation
- [x] S0a Repo foundation: `.nvmrc`, `engines`, strict tsconfig with `noUncheckedIndexedAccess`, a `typecheck` script, Makefile, `.env.example`, `progress.md`, `tests.json`. Replace the scaffold's HTTP listener, `AppController` and `@nestjs/observe` with a standalone application context. Zod settings where `TRADER_MODE` accepts only `paper`. Structured JSON logging. Settle the D1 and linter gaps listed in `CLAUDE.md`.
- [x] S0b Database: `docker-compose.yml` with Postgres 16, Drizzle and drizzle-kit with an empty first migration, and the `research/` uv skeleton.
- [x] S0c Settings and log redaction (D9, S0a review): remove `ANTHROPIC_API_KEY` from `.env.example`, the zod settings and their tests, because the app holds no secrets now (D9). Then harden redaction: it matches key paths only, so a secret nested two levels deep, under another key name, or interpolated into a message is logged in clear. Add a value-based scrub of the loaded secret values, today the `DATABASE_URL` password (for example through pino `hooks.streamWrite`), on top of the key paths, with tests for those three shapes. An unparseable `DATABASE_URL` must not leak its password through the parse error, which Node's `URL` includes in full (S0b review). Must merge before the app first connects to the database. Touches `src/config/`, so it needs a human.
- [x] S0d Dependency cleanup (S0a review): Express and `multer` remain through an optional peer of `@nestjs/core` (`pnpm audit --prod` shows one high advisory, unreachable here), and `@nestjs/mau` plus the `deploy` script bring most of the other advisories. Remove them or record why they stay, re-resolve the lockfile (this moves Nest 12.2 to 12.4 and other versions), and correct the `tests.json` entry for `no-telemetry.spec.ts`, which overstates the removal. Also pin `postgres:16` in `docker-compose.yml` to an exact image digest, and decide on an override for `esbuild@0.18.20` (GHSA-67mh-4wv8-2f99, dev server only, never used here), which drizzle-kit pulls in (S0b review). Add a fast-check property that `secretValues` accepts every `DATABASE_URL` that `parseSettings` accepts, because today that guarantee rests on zod internals that an upgrade could change (S0c review).
- [ ] S0e Database client (S0b review): add `src/db/client.ts` and the first connection. Every checkout publishes Postgres on `127.0.0.1:55432`, so a leftover worktree database or a renamed repo folder can stand in for the real one, where the 48-entry counter reads 0 and the kill switch is missing. Store a database identity marker and check it at boot: a missing or wrong marker is UNKNOWN, which blocks entries while exits stay allowed. Add a read-only role for `research/` before any research code connects, because today the only role is the `trader` superuser. Set the column conventions with a schema-scan test: money as `numeric` in string mode (no `mode: 'number'`, `real`, `doublePrecision` or numeric-mode `bigint`), time as `timestamptz` or epoch milliseconds, with a round-trip test under a non-UTC `TZ`. On a failed boot, two paths still print to stderr without the value scrub: Nest's default logger before `useLogger`, and Node's printer for the top-level rejection in `src/main.ts`. Database errors will reach them, so route both through `scrubSecrets`, and test that a failed connect at boot prints no password. Also test that the password the DB client derives (decoded `url.password` for `pg-connection-string`) is one of the forms `secretValues` returns (S0c review). Needs S0c merged first, and touches `src/db/migrations/`, so it needs a human.

## S1 Market data
- [ ] S1a Normalizer and validator: ms and µs timestamps (D12), duplicates, ordering, gaps, staleness, OHLC sanity, outliers, quarantine.
- [ ] S1b Bulk history loader from `data.binance.vision` with CHECKSUM verification.
- [ ] S1c Read-only REST adapters, rate-limit aware.
- [ ] S1d WebSocket workers: reconnect, rotation, resubscribe, gap backfill.

## S2 Features
- [ ] S2a Indicators: EMA, SMA, ATR, RSI, MACD, ROC, ADX, Bollinger width, RVOL, VWAP, plus the look-ahead guard test.
- [ ] S2b Structure: swings, HH/HL/LH/LL, BOS/CHoCH, ranges.
- [ ] S2c Flow, derivatives and breadth features.

## S3 to S6 Decision pipeline
- [ ] S3 Regime: market and asset regime, UNKNOWN blocks entries.
- [ ] Gate paths, a human change and not a factory job; the orchestrator stops here and asks (S0a review): add the planned entry gate, exit and EV code (`src/signals/gate.ts`, `src/positions/exits.ts`, `src/stats/ev.ts`, or their folders) to `PROTECTED` in `factory/gate.sh`, and decide whether the gate also runs `pnpm test:e2e` and `pnpm test:db`. `test:db` must run in the gate before S7b, or the 48-entry counter's database proofs never gate a merge (S0b review). Also consider tripwires for `@anthropic-ai/sdk`, `--dangerously-skip-permissions` and `bypassPermissions` in non-test code (D9).
- [ ] S4 Signal engine: registry, the §6 catalogue, the D5 gate, veto flags.
- [ ] S5 `trend_continuation` strategy and scanner with dedupe.
- [ ] S6a Replay and fill model over S2 to S5, without Claude.
- [ ] S6b `strategy_stats` table and EV computed by code, with the D14 window filter and the unfiltered numbers alongside.

## S7 and S8 Risk and execution (always needs a human)
- [ ] S7a `RISK_POLICY.yaml`, its loader, the hard checks, and `risk_events` audit.
- [ ] S7b 48-entry rolling counter and kill switch.
- [ ] S8a `ExchangeAdapter` interface and the order state machine.
- [ ] S8b Paper broker, resident stops and targets, ledger reconciliation, UNKNOWN recovery.

## S9 Claude agent (always needs a human)
- [ ] S9a `DecisionProvider` interface and the CLI provider (`claude -p` with the §9 lockdown flags, allowlisted environment, empty working folder, timeout, nightly preflight of version, flags and login), snapshot builder, zod schemas, system prompt, D14 window guard and nightly caps.
- [ ] S9b Investigation loop, `claude_decisions` persistence, replay eval.

## S10 to S12 Positions and operations
- [ ] S10a Deterministic exits: stop, TP1, TP2, ATR trail, time stop. Every exit must run with no Claude available (outside the window, CLI missing, usage limit), proven by a test.
- [ ] S10b Thesis health and emergency rules.
- [ ] S11a Event bus, scheduler, startup recovery, including the D14 window open and close events and settling paper stops and targets over gaps after sleep (D11).
- [ ] S11b `trader` CLI, `launchd` jobs (`trader run` with `KeepAlive`, the nightly research job, a power assertion during the window), daily report. Only `start:prod` fails on a missing `../.env`; `pnpm start` skips it and relies on `parseSettings` to refuse boot (S0a review). `trader kill --flatten` must boot and act with no Claude configuration and the CLI unavailable, proven by a test. `nestjs-pino` keeps one root logger per process, so a second app context in the same process reuses the first boot's scrub values; handle that if the CLI boots one. The daily report reads trading state from the database, never from log lines, because the scrub can rewrite them (S0c review).
- [ ] S12 Failure-injection suite.

The 14-day paper run and its review stay with you. They are not a factory job.
