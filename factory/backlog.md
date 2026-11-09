# Backlog

`/factory next` runs the first unchecked item. The orchestrator checks an item off only when its job merges.

Items follow `SLICE_1_PLAN.md` §5 in dependency order. The larger milestones are split so that each item fits one builder and one review. The plan's "Done when" for a milestone applies when its last item merges.

## S0 Foundation
- [x] S0a Repo foundation: `.nvmrc`, `engines`, strict tsconfig with `noUncheckedIndexedAccess`, a `typecheck` script, Makefile, `.env.example`, `progress.md`, `tests.json`. Replace the scaffold's HTTP listener, `AppController` and `@nestjs/observe` with a standalone application context. Zod settings where `TRADER_MODE` accepts only `paper`. Structured JSON logging. Settle the D1 and linter gaps listed in `CLAUDE.md`.
- [ ] S0b Database: `docker-compose.yml` with Postgres 16, Drizzle and drizzle-kit with an empty first migration, and the `research/` uv skeleton.
- [ ] S0c Log redaction hardening (S0a review): redaction matches key paths only, so a secret nested two levels deep, under another key name, or interpolated into a message is logged in clear. Add a value-based scrub of the loaded secret values (for example through pino `hooks.streamWrite`) on top of the key paths, with tests for those three shapes. Must merge before the app first connects to the database or calls Claude. Touches `src/config/`, so it needs a human.
- [ ] S0d Dependency cleanup (S0a review): Express and `multer` remain through an optional peer of `@nestjs/core` (`pnpm audit --prod` shows one high advisory, unreachable here), and `@nestjs/mau` plus the `deploy` script bring most of the other advisories. Remove them or record why they stay, re-resolve the lockfile (this moves Nest 12.2 to 12.4 and other versions), and correct the `tests.json` entry for `no-telemetry.spec.ts`, which overstates the removal.

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
- [ ] Gate paths, a human change and not a factory job; the orchestrator stops here and asks (S0a review): add the planned entry gate, exit and EV code (`src/signals/gate.ts`, `src/positions/exits.ts`, `src/stats/ev.ts`, or their folders) to `PROTECTED` in `factory/gate.sh`, and decide whether the gate also runs `pnpm test:e2e`.
- [ ] S4 Signal engine: registry, the §6 catalogue, the D5 gate, veto flags.
- [ ] S5 `trend_continuation` strategy and scanner with dedupe.
- [ ] S6a Replay and fill model over S2 to S5, without Claude.
- [ ] S6b `strategy_stats` table and EV computed by code.

## S7 and S8 Risk and execution (always needs a human)
- [ ] S7a `RISK_POLICY.yaml`, its loader, the hard checks, and `risk_events` audit.
- [ ] S7b 48-entry rolling counter and kill switch.
- [ ] S8a `ExchangeAdapter` interface and the order state machine.
- [ ] S8b Paper broker, resident stops and targets, ledger reconciliation, UNKNOWN recovery.

## S9 Claude agent (always needs a human)
- [ ] S9a Read-only tools, zod schemas, system prompt, budget manager.
- [ ] S9b Investigation loop, `claude_decisions` persistence, replay eval.

## S10 to S12 Positions and operations
- [ ] S10a Deterministic exits: stop, TP1, TP2, ATR trail, time stop. Exits must run with `ANTHROPIC_API_KEY` unset or blank, proven by a test; today a blank key refuses boot (S0a review).
- [ ] S10b Thesis health and emergency rules.
- [ ] S11a Event bus, scheduler, startup recovery.
- [ ] S11b `trader` CLI, `launchd` plist, daily report. `trader kill --flatten` must work with `ANTHROPIC_API_KEY` unset or blank, proven by a test. Only `start:prod` fails on a missing `../.env`; `pnpm start` skips it and relies on `parseSettings` to refuse boot (S0a review).
- [ ] S12 Failure-injection suite.

The 14-day paper run and its review stay with you. They are not a factory job.
