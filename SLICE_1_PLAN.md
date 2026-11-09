# Slice 1 — Thin End-to-End Paper Trader

**Status:** Draft for review
**Date:** 2026-10-24
**Revised:** 2026-11-09. Claude sits behind a `DecisionProvider`, runs through the `claude` CLI under your own login with no API key, and reads a snapshot built by code instead of calling tools (D9), the engine runs around the clock (D11), and Claude works only in a nightly window (D14).
**Parent document:** `Autonomous_Claude_Crypto_Trading_Agent_MASTER_BUILD_PLAN.md` (single source of truth for rules and philosophy)
**Stack override:** the master plan assumes Python throughout. This slice uses TypeScript/NestJS for the application and Python only for offline research (D2, D13). The master plan's rules apply unchanged.

This document defines **what gets built first** and **what is deliberately deferred**. Where it is silent, the master plan applies. Where it adds a rule, the rule is always *stricter* than the master plan, never looser.

---

## 1. Goal

A locally running **paper trader** that, on every 15-minute candle close:

1. scans a fixed universe of liquid Binance USDT pairs,
2. computes price, flow and derivatives signals,
3. applies the ≥5 signals / ≥3 families gate,
4. inside the nightly window (D14), lets Claude review a snapshot of each surviving candidate and propose (or decline) a trade; outside it, entries WAIT,
5. passes every proposal through the deterministic risk engine,
6. paper-fills approved trades against live Binance prices,
7. manages open positions around the clock with deterministic exits, plus Claude reassessment inside the window,
8. records everything and produces a daily report.

**No real orders. No Binance API keys. No Anthropic API key.** Slice 1 uses only public market data. Claude runs through the `claude` CLI under your own login (D9), so the app holds no secrets. Claude works only from 19:00 to 08:00 Europe/Ljubljana (D14), while the deterministic engine runs around the clock.

### Definition of done

- [ ] `trader run` runs unattended for 14+ days in paper mode without manual intervention
- [ ] Every Claude decision, risk decision, order, fill and exit is persisted and explainable from the DB
- [ ] Hard rules have dedicated passing tests: 5-signal, 3-family, 48-entry, UNKNOWN-blocks-entries, stale-data-blocks-entries, kill switch, no Claude call outside the window (including across DST changes)
- [ ] Failure-injection suite (§S12) passes
- [ ] Daily report generated each UTC day
- [ ] Baseline strategy statistics exist and EV is computed by code, never by Claude

---

## 2. Scope

| Area | In slice 1 | Deferred (widening) |
|---|---|---|
| Market | Binance **spot, long only** | Shorts, futures trading, leverage |
| Mode | **Paper** (simulated fills on live prices) | Shadow, testnet, tiny live |
| Universe | Static config list of ~15 liquid USDT pairs that also have USDⓈ-M perps | CMC Top-100 with historical membership |
| Timeframes | 1D (context), 4H, 1H, 15M | 5M entry timing, 1M microstructure |
| Data | Spot klines (incl. taker-buy volume), futures funding, OI, premium index, live book ticker | Order-book depth, aggTrades CVD, liquidations, cross-exchange |
| Intelligence | — | News, social, on-chain, macro, TradingView |
| Strategies | **1:** `trend_continuation` | breakout_retest, momentum_expansion, RS rotation, liquidation reversal, range mean reversion |
| Statistics | Baseline replay stats (simple fill model) | Full realistic backtester (partial fills, latency, impact) |
| Sentiment | "Thesis health" state from market-derived inputs only | News/social sentiment inputs |
| Ops | Single 24/7 process + Postgres in Docker, CLI, markdown report, nightly Claude window (D14) | Dashboard, Redis, HTTP controllers, TradingView webhook + tunnel |

---

## 3. Decisions for slice 1

Defaults chosen so work can start; items marked **(confirm)** are listed again in §11.

**D1 — Repo root.** This folder is the repo root (no nested `crypto-trading-agent/` directory). `git init` happens in S0. The master plan's repository layout is followed, but only the modules slice 1 needs are created.

**D2 — Stack.** TypeScript on **Node 26**, `pnpm`, `tsc` in `strict` mode. **NestJS** as the application framework: each module in §4 is a Nest module, and dependency injection selects the `ExchangeAdapter` implementation (D10).
- Validation and config: **zod** (env settings, `RISK_POLICY.yaml`, external payloads, Claude tool and output schemas)
- HTTP and streams: built-in `fetch` (undici), `ws`
- Database: **PostgreSQL 16** in Docker, **Drizzle ORM** + drizzle-kit migrations, `pg` driver
- Money and quantities: **decimal.js**. Never use JS `number` for prices, quantities, fees or P&L. Postgres `numeric` is read as a string and converted to `Decimal`. Plain `number` is allowed only for indicator math on prices that are already validated, and for timestamps (ms and µs both fit below 2^53).
- Events and scheduling: `@nestjs/event-emitter` (in-process bus), `@nestjs/schedule`
- CLI: `nest-commander`. Logging: `pino` via `nestjs-pino`.
- Tests: **vitest** + **fast-check** (property-based tests). Lint and format: typescript-eslint + Prettier.

Slice 1 runs Nest as a **standalone application context** (`NestFactory.createApplicationContext`) with no HTTP server. **No Redis** (in-process event bus) and **no HTTP controllers** in slice 1, since there is no inbound traffic. Both arrive with TradingView in W2 (Nest controllers; Redis + BullMQ).

**D3 — Universe.** Static list in config, e.g. BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, BCH, NEAR, SUI, TRX (all `…USDT`). A startup liquidity check (24h quote volume, spread) drops symbols that fail. The list lives in config, not code.

**D4 — Strategy.** `trend_continuation`: pullback-and-resume inside an established higher-timeframe uptrend. It produces more setups than `breakout_retest` and has simpler definitions. `breakout_retest` is the first widening item.

**D5 — Independence groups (confirm).** Families are grouped by underlying data source:

| Group | Families |
|---|---|
| `price` | structure, trend, momentum, volume, volatility, breakout, vwap_profile, relative_strength |
| `flow` | order_flow |
| `derivatives` | derivatives (funding, OI, basis) |
| `context` | breadth |

Entry gate = **≥5 counted signals AND ≥3 families AND ≥2 groups**, with **at most 2 signals counted per family**. This prevents the EMA-stack double counting the master plan warns about, and stops price data alone from passing the gate.

**D6 — EV source.** Probability and payoff come from the baseline statistics table (S6), keyed by `(strategy, market_regime, asset_regime)`. Code computes EV. If a bucket has fewer samples than `min_samples`, EV = `UNKNOWN` → reject. All values are labelled `PROVISIONAL` until the full backtester (W3) replaces them.

**D7 — Risk numbers.** Conservative **paper-only** values in `RISK_POLICY.yaml`, each tagged `provisional: true` (§8). None of them is promoted to live without research, as the master plan requires.

**D8 — 48-entry semantics (confirm).** Slice 1 has no pyramiding: one position per asset, and an *entry* = opening a position. Each entry writes a row to `trade_entry_counter` inside the same DB transaction as the risk approval, so the count can't race. Exits never count.

**D9 — Claude layer.** Code talks to Claude only through a **`DecisionProvider`** interface, the same pattern as the `ExchangeAdapter` (D10). Slice 1 ships one implementation, which runs the **Claude Code CLI** (`claude -p`) under your own Claude login as a child process. There is no `@anthropic-ai/sdk` and no `ANTHROPIC_API_KEY`: the app never holds an Anthropic credential. An API-based provider could be added later without touching anything else, because the snapshot, schemas, window, caps and WAIT fallbacks all sit outside the provider. **Claude gets no tools at all.** Code builds one compact snapshot per candidate or position and asks once. The final decision comes back as structured output against a JSON schema generated from the zod `TradeDecision` schema, and code re-validates it with zod. **Claude has no execution tools, and no read tools either, in slice 1.** The orchestrator (code) calls the risk engine and the paper broker. For slice 1 this replaces the master plan's Messages API and tool-loop design (decided 2026-11-09). Details in §9.

**D10 — Paper execution.** The paper broker implements the same `ExchangeAdapter` interface the live Binance adapter will implement in W8. Entries are market orders filled at live best ask + slippage + taker fee. Stops and targets are held **inside the paper broker**, mimicking exchange-resident orders, so the live adapter later maps them 1:1 to Binance stop/OCO orders. The order state machine is the master plan's §29, unchanged.

**D11 — Process model.** One Node process (`trader run`) supervised by `launchd` with `KeepAlive`, running 24/7 whenever the Mac is awake, plus Postgres in Docker. It needs no Claude: market data, features, signals, the scanner, the paper broker's resident stops and targets, deterministic exits and reconciliation all run around the clock, and Claude is used only inside the D14 window. Unhandled promise rejections and uncaught exceptions crash the process loudly so `launchd` restarts it; nothing is swallowed. On restart or wake it backfills candle gaps over REST, settles paper stops and targets that the gap's candles would have triggered (stop first if both are touched), checks ledger invariants, then resumes. In paper mode, downtime only costs opportunities. In live mode (W8), exchange-resident stops become mandatory precisely because of this. A second `launchd` job runs the offline research scripts once a night (D13). That job is code, not Claude.

**D12 — Time.** UTC everywhere. Binance REST uses millisecond timestamps, but **bulk spot files on `data.binance.vision` now use microseconds** (verified on the 2026-10-01 BTCUSDT 15m file). The normalizer must detect and handle both.

**D13 — Language boundary (TypeScript vs Python).** **Every piece of logic used in both live trading and replay exists once, in TypeScript:** normalization, validation, indicators, structure, signals, the gate, regime, strategy geometry, the fill model, EV and the risk engine. The S6 replay runs these same TypeScript modules over historical data. Reimplementing any of them in Python (pandas, vectorbt, …) for backtesting isn't allowed, because the two versions would drift and the stats would describe a strategy that isn't running.
Python (3.12, `uv`) lives only in `research/`, for **offline** work: notebooks, exploratory statistics and plots. It reads from Postgres. Anything it produces (parameter proposals, reports) is data, and it affects trading only after the TypeScript replay reproduces it. Python is never in the live decision path and never writes to the trading tables. Pine scripts (W2) stay Pine.

**D14 — Nightly Claude window (decided 2026-11-09).** Claude may run only from **19:00 to 08:00 Europe/Ljubljana**, so your daytime Claude usage is untouched. The window lives in config as an IANA time zone plus local start and end times for each weekday. The default is 19:00–08:00 every day, so widening weekends later is a config change. Code converts it to UTC intervals, handling DST, and every stored timestamp stays UTC.
- **Enforced in code, not by a schedule.** The Claude client checks the window before it starts the CLI. Outside the window, a call returns WAIT with reason `outside_window` and no process starts.
- **Entries happen only inside the window,** because an entry needs Claude's BUY. A candidate that passes the gate outside the window is logged as WAIT `outside_window`, so the report shows what the window costs.
- **Cadence is event-driven.** At each 15m close inside the window, code scans as usual. Claude reviews only candidates that pass the gate, after dedupe and a per-asset cooldown, up to a **nightly cap** (§9). There are no fixed time slots.
- **Positions are managed 24/7 without Claude.** Outside the window, a WARNING thesis state is handled by the deterministic rules, as during a Claude outage (S10).
- **Usage limits.** Calls run on your Claude subscription. The window keeps them out of your working hours, and the nightly cap bounds the total, which matters if your plan also has a weekly limit. A usage-limit error ends Claude calls for the rest of the night (→ WAIT).
- **Replay matches live.** Live entries can only come from setups whose signal bar closes inside the window, so the S6 stats for the strategy version apply the same window. The replay report also shows the unfiltered numbers for comparison.
- **The Mac must be awake.** `launchd` jobs don't run while the Mac sleeps. During the window, `trader run` holds a power assertion against idle sleep (as `caffeinate -is` does). Keeping the Mac plugged in, with the lid open or in clamshell mode with a display, is your responsibility. Sleep is logged as downtime and shown in the daily report.

---

## 4. Slice 1 architecture

```text
Binance public REST + WebSocket          data.binance.vision (bulk history)
            │                                        │
            ▼                                        ▼
      market_data (ingest → normalize → validate → store) ──► Postgres
            │
   on 15m close (event bus)
            ▼
   indicators / structure / derivatives / breadth   (pure functions, shared with replay)
            ▼
   regime (market + asset; UNKNOWN blocks entries)
            ▼
   signals (registry, freshness, family/group counting)
            ▼
   strategy scanner (trend_continuation setup + plan geometry)
            ▼
   GATE  ≥5 signals · ≥3 families · ≥2 groups · ≤2 per family
            ▼
   snapshot (code) ──► DecisionProvider: `claude -p`, 19:00–08:00 only, no tools ──► TradeDecision (BUY / WAIT / REJECT)
            ▼
   EV from stats table (code) ──► risk engine (hard checks, 48-counter, kill switch)
            ▼
   paper broker (order state machine, fills, resident stop/targets)
            ▼
   position manager ──► deterministic exits  |  thesis health ──► Claude reassess in window (HOLD / REDUCE / CLOSE)
            ▼
   reporting (daily markdown) · audit tables
```

### Module layout (subset of master §2, adapted to TypeScript/NestJS)

Each folder under `src/` is a Nest module (`<name>.module.ts`). Calculation code (indicators, structure, signals, gate, EV, risk checks) is written as **plain pure functions** with no Nest or DB dependencies, so replay and tests can call them directly. Nest services only wire them to data and events.

```text
src/
  main.ts          CLI bootstrap (nest-commander, standalone context)
  config/          settings.ts (zod env schema), risk-policy.ts (YAML loader + zod schema)
  db/              schema.ts (Drizzle), client.ts, migrations/ (drizzle-kit)
  shared/          decimal.ts, time.ts, result types
  market-data/     binance-spot.ts, binance-futures.ts, bulk-loader.ts,
                   websocket-manager.ts, normalizer.ts, validator.ts
  indicators/      ema, sma, atr, rsi, macd, roc, adx, bollinger, rvol, vwap
  structure/       swings, hh-hl, bos-choch, ranges
  derivatives/     funding, open-interest, basis
  breadth/         universe breadth
  regime/          market-regime.ts, asset-regime.ts
  signals/         registry.ts, definitions/, gate.ts
  strategies/      trend-continuation.ts, base.ts
  stats/           replay.ts, fill-model.ts, stats-table.ts, ev.ts
  risk/            engine.ts, checks/, entry-counter.ts, kill-switch.ts
  execution/       exchange-adapter.ts (interface), paper-broker.ts, order-state.ts
  positions/       manager.ts, exits.ts, thesis-health.ts
  claude/          decision-provider.ts (interface), cli-provider.ts, snapshot.ts, schemas.ts (zod), window.ts, budget.ts
  orchestrator/    events.ts, scheduler.ts, recovery.ts
  reporting/       daily-report.ts
prompts/           claude_system.md (versioned)
scripts/           backfill.ts, replay.ts
test/              unit/ risk/ execution/ agent/ failure-injection/ fixtures/
research/          Python (uv): notebooks/, reports/ (offline only, see D13)
```

---

## 5. Milestones

Each milestone is one or more Claude Code sessions. Following master §24, each session reads `progress.md` and `tests.json` first, writes tests first where practical, never deletes tests to go green, and stops if a prerequisite is missing.

### S0 — Foundation
- `git init`, `package.json` (pnpm, Node 26 pinned via `.nvmrc` + `engines`), `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), NestJS skeleton, vitest, typescript-eslint + Prettier, `Makefile`, `.gitignore`, `.env.example` (only `DATABASE_URL` and `TRADER_MODE=paper`; S0a shipped `ANTHROPIC_API_KEY` too, and S0c removes it per D9)
- `docker-compose.yml` with Postgres 16; Drizzle + drizzle-kit wired with an empty first migration
- `research/` with its own `pyproject.toml` (uv); it isn't part of the TypeScript build or test run
- Typed settings (zod): `TRADER_MODE` accepts only `paper` in slice 1 (`live` isn't implemented, not just disabled). Secrets never logged.
- Structured JSON logging with correlation IDs
- `progress.md`, `tests.json`, project `CLAUDE.md` with the non-negotiable rules
- **Done when:** `make test`, `make lint`, `make typecheck` and `make db-up` pass on a clean checkout

### S1 — Market data
- **Bulk history loader** from `data.binance.vision`: spot klines (15m, 1h, 4h, 1d), USDⓈ-M `fundingRate` (monthly), `metrics` (5m OI + long/short ratios, daily files), `premiumIndexKlines`, with CHECKSUM verification
- **REST adapters** (read-only): exchangeInfo, klines, bookTicker, funding, OI, premium index; rate-limit aware
- **WebSocket workers:** `kline_15m`, `kline_1h`, `bookTicker` for the universe; ping/pong, reconnect with exponential backoff and jitter, proactive rotation before the 24h connection limit, resubscribe, gap backfill over REST after any reconnect
- **Validation:** duplicates, out-of-order rows, gaps, staleness, OHLC sanity, outliers. Invalid data is quarantined, never silently used. Missing data is represented explicitly. Note that the metrics files have **irregular gaps** (e.g. 00:30 → 01:25 seen on 2026-10-01).
- Storage keeps the kline fields the master schema omits: `quote_volume`, `taker_buy_base_volume`, `taker_buy_quote_volume`
- **Done when:** history from 2022-01 for the universe is loaded, and a 24h live run shows no unhandled gaps, with forced disconnects recovered

### S2 — Indicators, structure, features
- Pure TypeScript functions over arrays (`Float64Array` where useful); **the same code path for replay and live** (D13)
- EMA, SMA, ATR (Wilder), RSI, MACD, ROC, ADX, Bollinger width, RVOL, session VWAP, anchored VWAP (from swing low)
- Swing points, HH/HL/LH/LL, BOS/CHoCH, range detection
- Flow: taker-buy ratio and a CVD proxy from klines (`2·taker_buy − volume`)
- Derivatives: funding percentile (rolling), OI change %, price/OI relationship, basis from the premium index
- Breadth: % of universe above EMA20/50 (1h, 4h), advance/decline
- Look-ahead guard: every feature at time *t* uses only closed bars ≤ *t*, enforced by a test that shifts the input and checks invariance
- **Done when:** indicator tests pass against hand-computed fixtures and the look-ahead test passes

### S3 — Regime
- Market regime from BTC 4H/1D trend, breadth, realized-vol percentile and ATR percentile, using master §9 states (CRASH and LIQUIDITY_STRESS via simple deterministic rules in slice 1)
- Asset regime from the asset's own trend and volatility
- `UNKNOWN` whenever inputs are stale, missing, or warm-up is incomplete → blocks entries
- **Done when:** transition tests pass and UNKNOWN-blocks-entry is tested end to end

### S4 — Signal engine
- `Signal` object: `name, family, group, direction, strength∈[0,1], value, timeframe, as_of, valid_until, version`
- Strength is normalized with **training-period statistics only** (persisted with the stats version)
- Gate per D5. The gate result records which signals were counted, which were capped, and why.
- Penalty flags (not counted signals) can veto: extreme funding, OI spike with flat price, bearish divergence
- **Done when:** gate unit and property tests pass. No combination of signals from one family can pass the gate, and stale signals never count.

### S5 — Strategy and scanner
- `trend_continuation` spec: allowed regimes (STRONG_BULL, WEAK_BULL, RECOVERY), setup (4H uptrend, 1H pullback to EMA20/50 or VWAP, 15M resumption), entry, stop (below swing low, bounded by ATR multiples), TP1/TP2 (R multiples, adjusted to structure), trailing after TP1, time stop
- Scanner runs on each 15m close and emits `CandidateEvent`s only when the gate passes *and* the strategy setup is present
- Dedupe: the same setup isn't re-sent to Claude unless state changed materially (new bar with a new signal set, or price moved > x·ATR)
- **Done when:** replaying a fixture day produces deterministic, identical candidate sets

### S6 — Baseline statistics (replay)
- Replays S2–S5 over history **without Claude**, calling the same TypeScript modules as live (D13), using a simple fill model: entry at next bar open + slippage + fee. Stops and targets are checked intrabar with the conservative tie-break (stop first if both are touched).
- Splits: train 2022-01 → 2024-06, validation 2024-07 → 2025-06, **untouched test 2025-07 → 2026-09**. Parameters are chosen on train, sanity-checked on validation. Test is run once per strategy version.
- Output: `strategy_stats` table per `(strategy_version, market_regime, asset_regime)` with n, win rate, avg win R, avg loss R, expectancy R, cost assumptions, data range
- **Window filter (D14):** the stats for a strategy version count only setups whose signal bar closes inside the Claude window. Positions are then managed around the clock, as live. The report also shows the unfiltered numbers.
- `ev.ts`: EV in R and in quote currency, net of fees, slippage and spread, from stats + plan geometry
- **Known bias:** today's liquid universe projected backward is survivorship-biased, so slice 1 stats will be optimistic. W5 fixes this. Until then, stats are `PROVISIONAL`.
- **Done when:** the replay report is produced and the stats table is populated. EV is UNKNOWN for thin buckets.

### S7 — Risk engine
- Loads and validates `RISK_POLICY.yaml` (schema-checked; the process refuses to start on an invalid policy)
- Checks (subset of master §21): data healthy · market regime allowed · asset regime allowed · spread ≤ max · gate passed (re-verified independently, not trusted from upstream) · EV known and > 0 · R:R ≥ min · stop geometry valid · per-trade risk ≤ limit · total/asset exposure · max concurrent positions · daily loss limit · **48-entry rolling counter** · cooldown after stop-out · no UNKNOWN orders · ledger reconciliation clean · kill switch off
- Computes the final quantity (master §20 formula plus exchange lot/notional filters). Claude never sets quantity.
- Every evaluation is written to `risk_events` with each check's value, limit and result
- Kill switch: DB flag + `trader kill` / `trader resume`. Kill blocks entries, and with `--flatten` also closes positions.
- **Done when:** property tests show no input yields approval when any hard check fails. 48-counter tests cover the rolling-window boundary, concurrency and restart.

### S8 — Paper broker and order state machine
- `ExchangeAdapter` interface: `submitOrder`, `cancelOrder`, `getOrder`, `getOpenOrders`, `getFills`, `getBalances`. All amounts are `Decimal`.
- Paper broker: market entry fills from the live `bookTicker` + slippage + fee. Resident stop/target orders are triggered by live prices, with stop fills taking adverse slippage.
- Order state machine as in master §29. Every order has a unique `client_order_id`, and submission is idempotent.
- Failure injection can force `UNKNOWN`: entries block, and the reconcile routine runs and clears it
- Ledger reconciliation: cash + positions = equity, Σfills = position qty, no orphan orders. A mismatch pauses trading.
- **Done when:** state-machine tests, idempotency tests and the UNKNOWN recovery test pass

### S9 — Claude agent
See §9 for the design.
- `DecisionProvider` interface and the CLI provider: `claude -p` with the §9 lockdown flags, an allowlisted environment, an empty working folder and a hard timeout. A preflight checks the CLI version, its flags and the login before each night.
- Snapshot builder: one compact, versioned snapshot per candidate or position with the §9 sections, `as_of` and data-health flags, and a stable hash
- `TradeDecision` and `PositionDecision` schemas, system prompt `prompts/claude_system.md` (master §10 adapted to slice 1 scope), versioning of prompt, snapshot and schema
- Window guard (D14) and budget manager: nightly cap, per-asset cooldown, per-call timeout, and no more calls that night after a usage-limit error
- Persistence in `claude_decisions`: snapshot hash and version, provider, CLI version, model, effort, prompt version, output, usage as the CLI reports it, latency, exit reason
- A small **replay eval**: ~20 recorded candidate snapshots (clean setups, setups with strong counter-evidence, stale-data traps) run before any prompt change ships
- **Done when:** end-to-end candidate → Claude → risk → paper fill works on live data. Malformed output, refusal, timeout, usage limit, the nightly cap, a missing or changed CLI, and any call outside the window all degrade to WAIT. A test proves the CLI session has no tools: no shell, files, web or MCP server. A contract test runs recorded snapshots through a fake provider to prove the window, caps and fallbacks don't depend on the CLI.

### S10 — Position manager and exits
- Deterministic exits: stop, TP1 (partial), TP2, ATR trail after TP1, time stop
- **Thesis health** (master's sentiment states, market-derived inputs only): structure break on 15m/1h, flow deterioration, funding becoming extreme, OI crowding, adverse price/volume reaction, BTC regime shift
  - `HEALTHY` → normal management
  - `WARNING` → Claude reassessment (HOLD / REDUCE / CLOSE) inside the window. Outside it, or when Claude is unavailable, HOLD under the deterministic rules.
  - `BAD` → deterministic reduce or close per policy; Claude is informed but not waited on
  - `CRITICAL` → immediate close, no Claude
- Emergency rules (deterministic): BTC drawdown beyond threshold within one 15m bar, spread blowout on a held asset, held-asset data stale beyond threshold, kill switch with flatten
- Exits are **always allowed** by the risk engine and skip entry checks
- **Done when:** each state transition and each exit path has a test, and no exit requires five bearish signals or Claude

### S11 — Orchestrator and operations
- Event bus and scheduler (candle-close events, 1-minute position ticks, reconciliation ticks, Claude window open and close)
- Startup recovery: load state → backfill gaps → reconcile → resume, or stay paused with a reason
- CLI (`nest-commander`): `trader run | status | kill [--flatten] | resume | backfill | replay | report`
- `launchd`: `trader run` with `KeepAlive`, a nightly research job (offline scripts in `research/`, D13), and a power assertion during the Claude window. Keep-awake guidance for the Mac (D14).
- Daily report (markdown): equity, P&L, drawdown, positions, entries per asset (48-counter), candidates, Claude decisions (BUY/WAIT/REJECT mix), risk rejections by rule, exits by reason, fees, slippage, Claude calls against the nightly cap, Claude usage as the CLI reports it, downtime and sleep, data-health incidents
- **Done when:** the process survives a reboot and resumes correctly, and the report generates

### S12 — Failure injection and paper run
- Tests: WS disconnect and rotation, REST outage and 429s, stale data, DB unavailable, Claude unavailable / malformed / refusal / nightly cap reached / usage limit / CLI missing or changed / call outside the window, Mac asleep with an open position, duplicate candle events, forced UNKNOWN order, restart with an open position, clock skew
- Then a **14-day paper run** and a review of the daily reports, which decides the widening order (§10)

---

## 6. Slice 1 signal catalogue

Thresholds are parameters, fit on the **train split only**. TF = evaluation timeframe.

| Signal | Family | Group | Sketch | TF |
|---|---|---|---|---|
| `htf_uptrend` | trend | price | close > EMA200, EMA50 > EMA200, EMA50 slope > 0 | 4H |
| `ema_alignment` | trend | price | EMA20 > EMA50 and price above EMA50 | 1H |
| `higher_low_held` | structure | price | pullback low above prior swing low | 1H |
| `bullish_bos` | structure | price | close above last lower-high after a higher low | 15M |
| `momentum_resumption` | momentum | price | RSI back above 50 after pullback with MACD histogram rising | 15M |
| `rvol_demand` | volume | price | RVOL ≥ train-percentile on an up close | 15M |
| `vol_expansion_from_compression` | volatility | price | BB width leaves the low-percentile zone | 1H |
| `range_break` | breakout | price | close above an N-bar range high with RVOL confirmation | 1H |
| `vwap_reclaim` | vwap_profile | price | close back above anchored VWAP from the swing low and holds | 15M |
| `rs_vs_btc` | relative_strength | price | RS(asset, BTC) > 0 and rising | 1H |
| `taker_buy_pressure` | order_flow | flow | taker-buy ratio above train-percentile, CVD-proxy slope > 0 | 15M |
| `funding_not_crowded` | derivatives | derivatives | funding percentile inside a healthy band | 8H |
| `oi_confirms_price` | derivatives | derivatives | OI rising with price while funding isn't extreme | 1H |
| `basis_healthy` | derivatives | derivatives | premium index inside a healthy band | 1H |
| `breadth_supportive` | breadth | context | % universe above EMA50 above threshold, BTC regime not bearish | 1H |

**Veto flags** (not signals): `funding_extreme`, `oi_spike_flat_price`, `bearish_divergence_1h`, `spread_too_wide`.

---

## 7. Database (slice 1)

Uses the master §4 schema for: `assets, candles, funding, open_interest, signals, regimes, trade_intents, orders, fills, positions, risk_events, claude_decisions, system_events, trade_entry_counter`.

**Additions** (to be merged into the master schema):
- `candles`: `quote_volume`, `taker_buy_base_volume`, `taker_buy_quote_volume`, `is_closed`
- `premium_index` (asset, timestamp, OHLC of the premium index)
- `strategy_stats` (strategy_version, market_regime, asset_regime, n, win_rate, avg_win_r, avg_loss_r, expectancy_r, cost_model_version, data_from, data_to)
- `paper_account` (timestamp, cash, equity, realized_pnl, fees_paid)
- `trade_intents`: `ev_source` (`stats:<version>`), so it's always traceable that EV came from code
- `claude_decisions`: `input_tokens, output_tokens, cache_read_tokens, notional_cost_usd` (the CLI's estimate; nothing is billed per call), `cli_version, exit_reason, window_night` (the local date the night started)

---

## 8. `RISK_POLICY.yaml` (provisional paper values)

```yaml
system:
  mode: paper
  default_action: WAIT
  max_entries_per_asset_rolling_24h: 48     # hard, from master plan

entry:
  minimum_signals: 5                        # hard, from master plan
  minimum_signal_families: 3                # hard, from master plan
  minimum_independence_groups: 2            # slice 1 addition (stricter)
  max_counted_signals_per_family: 2         # slice 1 addition (stricter)
  require_data_health: true
  require_reconciliation_clean: true
  require_known_positive_ev: true
  min_reward_risk_tp1: 1.5                  # provisional
  stats_min_samples: 30                     # provisional

sizing:                                     # all provisional, paper only
  paper_starting_equity_usdt: 10000
  risk_fraction_per_trade: 0.0025
  stop_atr_min: 0.8
  stop_atr_max: 3.0

portfolio:                                  # all provisional, paper only
  max_concurrent_positions: 3
  max_asset_exposure_pct: 20
  max_total_exposure_pct: 60
  daily_loss_limit_pct: 1.5                 # breach → no new entries until next UTC day
  cooldown_after_stop_minutes: 120

execution:
  max_spread_bps: 10                        # provisional
  paper_slippage_bps: 5                     # provisional
  paper_taker_fee_bps: 10                   # provisional
  reject_on_stale_data: true
  unknown_order_blocks_new_entries: true

thesis_health:                              # thresholds VALIDATE in replay
  bad_action: CLOSE_50_THEN_REASSESS
  critical_action: EMERGENCY_CLOSE

safety:
  kill_on_reconciliation_failure: true
  kill_on_unexpected_position: true
  kill_on_database_integrity_failure: true

provisional: true                           # loader refuses mode != paper while true
```

---

## 9. Claude layer design

**How Claude is called**
- **Behind an interface.** Code calls `DecisionProvider.decide(snapshot)` and gets back a `TradeDecision`, a `PositionDecision` or WAIT with a reason. The window check, caps, timeout, zod validation and WAIT fallbacks live outside the provider, so any later provider gets them unchanged.
- **The slice 1 provider** starts the **Claude Code CLI** as a child process, `claude -p`, under your own Claude login. The app never handles a credential. The child's environment is built from an allowlist, so an `ANTHROPIC_API_KEY` in the parent environment never reaches it and can't switch it to API billing.
- **One turn, no tools.** The snapshot goes in the prompt, and Claude answers once.
- **Lockdown flags** on every call:
  - `--tools ""`: no built-in tools, so no shell, file access, web search or web fetch.
  - `--strict-mcp-config` with an empty MCP config, so none of your MCP servers load.
  - `--permission-mode dontAsk` and `--permission-prompts none`, so anything that would need a permission is denied without a prompt.
  - `--setting-sources` and `--settings` chosen so that no user, project or local hooks, plugins or settings load. S9 proves this with a test. `--bare` can't be used, because it forces API-key auth.
  - `--system-prompt-file prompts/claude_system.md`, replacing the default system prompt.
  - `--output-format json --json-schema <TradeDecision schema>` for structured output.
  - `--model` and `--effort` from config per call type (provisional: `high` for entries, `medium` for reassessments), and `--no-session-persistence`.
  - The working folder is an empty folder used only for these calls, so no `CLAUDE.md` or project memory is picked up.
- **Preflight** before each night: `claude --version` is within a pinned range, `claude --help` lists every required flag, and `claude auth status` shows a valid login. If any check fails, there are no Claude calls that night (→ WAIT), and the report says why. The CLI version is stored with every decision. A long-lived token from `claude setup-token` is not used, because it would put a secret back in the app.
- **Hard timeout** per call: the provider kills the child's process group, and the result is WAIT.
- **Output is never trusted.** Code checks the exit code and the result's error fields, then re-validates the structured output with zod.
- **Budget:** one call per candidate, a nightly cap on entry reviews and on reassessments (provisional: 20 and 10), and a per-asset cooldown. When a cap is hit or the CLI reports a usage limit, new reviews stop for the night (→ WAIT) while deterministic exits keep working.
- **Window:** every call goes through the D14 window check first.

**Snapshot (built by code, one per call; compact JSON with `as_of`, data-health flags and a schema version; its hash is the decision's input hash)**

| Section | Contents |
|---|---|
| Market state | Summarized OHLCV features per timeframe, structure, key levels; no raw candle dumps |
| Signals | Signal matrix with family, group, strength, freshness, gate result, vetoes |
| Derivatives | Funding (level, percentile, trend), OI change, price/OI relation, basis |
| Regime | Market regime, breadth, BTC context |
| Strategy stats | Baseline stats bucket, EV inputs, sample size, `PROVISIONAL` flag |
| Portfolio | Paper equity, exposure, open positions, daily P&L, 48-counter per asset |
| Position (reassessments only) | Position, stops and targets, thesis health, earlier reassessments |

**No tools at all.** Claude reads the snapshot and returns a decision, and code does everything after that. The same snapshot always produces the same input hash, so the replay eval can rerun any decision exactly. If the eval shows Claude needs to look further, read-only tools can come back in a later widening.

**`TradeDecision` (entries)**: `decision ∈ {BUY, WAIT, REJECT}`, symbol, strategy, counted signals (echoed from the gate, not invented), thesis, counter_thesis, scenarios {bull, base, bear, crash}, catalyst (may be `none`), invalidation, proposed entry/stop/TP1/TP2 (bounded by strategy geometry and validated by risk), expected duration, `why_this_could_fail`, data concerns.
Compared with master §12, `expected_probability`, `expected_rr` and `expected_value` are **filled by code** from the stats table, which follows master rule 13.

**`PositionDecision` (reassessment)**: `decision ∈ {HOLD, REDUCE, CLOSE}`, fraction, reason, which thesis element failed.

**Failure behavior:** malformed output, refusal, timeout, CLI error, usage limit, failed preflight, nightly cap reached or a call outside the window → entry = WAIT, logged with reason. Position management falls back to deterministic rules. A Claude outage never blocks an exit.

**Usage estimate (to verify in S9):** a single-turn entry review reads roughly 10–20K tokens (system prompt plus snapshot) and writes 3–10K including thinking. That's about a third of what a multi-turn tool loop would use, so the nightly cap goes about three times further. Calls run on your subscription, so there is no per-call bill. The CLI's JSON reports usage and a notional dollar figure, which the daily report shows against the nightly cap. The cap is the control, not money.

**Injection surface:** slice 1 feeds Claude no external text (no news or social), so the injection surface is minimal. The CLI session also has no tools at all, so even a successful injection could only shape a proposal, which the risk engine still checks. The system prompt still states that tool outputs are data, never instructions, because W4 adds news.

---

## 10. Widening roadmap after slice 1

Order to be revisited after the S12 paper review.

| # | Item | Master phases |
|---|---|---|
| W1 | `breakout_retest` + `momentum_expansion` strategies, each with its own stats | 12, 24 |
| W2 | TradingView: Pine scripts, webhook (Nest HTTP controller), Cloudflare Tunnel, auth/dedupe/queue (Redis + BullMQ) | 8 |
| W3 | Full realistic backtester (partial fills, latency, impact, rejections), walk-forward, Monte Carlo, perturbation | 25, 34 |
| W4 | News ingestion (verified sources only) + sentiment inputs into thesis health | 18, 33 |
| W5 | CMC Top-100 universe with historical membership (removes survivorship bias) | universe, 21 |
| W6 | Order-book depth family + aggTrades CVD | 15, 16 |
| W7 | Shadow mode (live decisions, no orders, compare to outcomes) | 35 |
| W8 | Binance live adapter: separate execution process holding the keys, exchange-resident stop/OCO orders, user-data stream, real reconciliation | 28, 29 |
| W9 | On-chain, social, macro providers | 17, 19, 20 |
| W10 | Production gate report + explicit human approval → tiny live | 36 |

---

## 11. Open decisions

1. **48-entry semantics.** Default: no pyramiding, so an entry = opening a position. Do you want scale-ins (adds to an existing position counted as entries) later?
2. **Claude model.** Default: the CLI's `--model` set to the strongest model your plan allows, for everything. A cheaper triage step in front would stretch the nightly cap. Worth adding?
3. **Nightly Claude cap.** Proposed: 20 entry reviews and 10 reassessments per night. Tune it after a week of watching usage against your daytime limits.
4. **Independence-group rule (D5).** It adds ≥2 groups and ≤2 per family on top of the master gate. Confirm.
5. **Universe list (D3).** Keep the proposed 15, or name your own?
6. **Futures access.** Only matters from W8, but it's worth checking now whether your Binance account can trade USDⓈ-M futures in your jurisdiction.
7. **Subscription terms.** Slice 1 now runs Claude unattended under your personal login. Check that your plan's terms allow automated use of Claude Code like this. If they don't, D9 needs revisiting.

---

## 12. Coverage of master plan phases

| Master phase | Slice 1 coverage |
|---|---|
| 1–4 Repo, config, DB, logging | Full |
| 5–7 Binance data, WebSockets, validation | Spot + futures public data, full |
| 8 TradingView | Deferred (W2) |
| 9–10 Indicators, structure | Full |
| 11 Volume profile | Deferred (VWAP only) |
| 12 Breakouts | Range break signal only |
| 13–15 RS, regime, derivatives | Full (no liquidations) |
| 16–20 Cross-exchange, on-chain, news, social, macro | Deferred |
| 21 Breadth | Universe breadth |
| 22 Anomaly | Deferred |
| 23 Signal engine | Full + stricter independence rule |
| 24 Strategies | 1 of 6 |
| 25 Backtester | Baseline replay only |
| 26–29 Risk, portfolio, execution, reconciliation | Full, paper adapter |
| 30–33 Claude agent (snapshot in slice 1, tools deferred), position mgmt, sentiment | Full, market-derived thesis health |
| 34 Failure testing | Slice-scoped suite |
| 35 Paper | Paper yes, shadow deferred |
| 36 Production gate | Deferred |
