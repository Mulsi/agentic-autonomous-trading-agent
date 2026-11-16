# S1a Normalizer and validator

## Goal

Build the first market-data code: pure TypeScript that turns raw Binance kline rows into validated candles. Live trading and replay share it (D13), so it has no Nest, DB, network or clock dependency.

It must:

1. **Read both time units (D12).** Binance REST sends epoch milliseconds. Bulk spot files on `data.binance.vision` now send epoch microseconds. Each timestamp is detected and converted to epoch ms. A value that fits neither unit is invalid.
2. **Parse money exactly.** Prices and volumes become `Decimal`, never a JS `number`.
3. **Check each row on its own.** This covers shape, timestamps, interval alignment, OHLC sanity and volume consistency.
4. **Check the batch.** This covers duplicates, input order, the requested range, future bars, closed versus still-open bars, and outliers.
5. **Report missing data explicitly.** Every expected slot either holds an accepted candle or is listed as missing.
6. **Judge staleness** with a pure freshness function. Anything but FRESH blocks entries.
7. **Quarantine invalid data and never drop it silently.** Every input row is accounted for in exactly one output bucket.

Quarantine is a **pure result type in this job, with no table, no migration and no human**. The reasons are under "Quarantine: result type, not a table" below.

## Plan references

- Backlog S1a (`factory/backlog.md` line 17).
- SLICE_1_PLAN:
  - **D12**: UTC everywhere. REST uses ms, bulk spot files use µs ("verified on the 2026-10-01 BTCUSDT 15m file"), and the normalizer must detect and handle both.
  - **D13**: normalization and validation exist once, in TypeScript, and the S6 replay calls the same modules.
  - **D2**: decimal.js for money, with `numeric` read as a string. Plain `number` is allowed only for timestamps, and for indicator math on prices that are already validated. zod validates external payloads.
  - **§2**: the timeframes are 1D, 4H, 1H and 15M.
  - **§4**: the module layout puts `market-data/normalizer.ts`, `market-data/validator.ts` and `shared/decimal.ts` here. Calculation code is plain pure functions, and Nest services only wire them.
  - **§5 S1**, "Validation": duplicates, out-of-order rows, gaps, staleness, OHLC sanity and outliers. "Invalid data is quarantined, never silently used. Missing data is represented explicitly." The metrics files have irregular gaps (00:30 → 01:25 on 2026-10-01).
  - **§5 S1**, storage keeps `quote_volume`, `taker_buy_base_volume` and `taker_buy_quote_volume`. **§7** adds them to `candles`, together with `is_closed`.
  - **§5 S2**: a feature at time *t* uses only closed bars ≤ *t*. **§5 S3**: stale or missing inputs make the regime UNKNOWN.
  - **§7**: the slice 1 table list has no quarantine or data-quality table.
  - **§8**: `reject_on_stale_data: true` and `require_data_health: true` are in the policy, but no staleness threshold is given.
- Master plan:
  - Part I §3 Rule 9 (UNKNOWN blocks entries), Rule 11 (external content is data), Rule 12 (default WAIT).
  - Part I §9: UNKNOWN means no new positions.
  - Part I §21: "data healthy" is the first hard check.
  - Part II §4: the `candles` table, keyed `(asset_id, timeframe, timestamp)`, and `system_events`.
  - Part II §13 (end): "Do not invent production numeric limits ... Research and validate those values first."
  - Part II §24 Phase 7: "Implement freshness, sequence, timestamp, duplicate and outlier validation. Invalid data must never silently enter the strategy engine." Also: keep `progress.md` and `tests.json` current.
- `progress.md` settlements:
  - Time is UTC epoch ms.
  - Tables arrive with the job that first uses them.
  - The D9 dependency test.

### Quarantine: result type, not a table

This job adds no persistence. The reasons:

- **§4 and D13.** Validation is calculation code that replay must call without a database. Writing to a table from it would break that, and a Nest service around it has nothing to wire yet.
- **§7 and master §4** list no quarantine table, and the S0 Database settlement says each table arrives with the job that first uses it. S1a stores nothing: no candles, no rows. S1b, the bulk loader, is the first job that writes market data. It decides whether quarantined rows are stored, where, and through which migration. That job touches `src/db/migrations/` and so needs a human.
- **Nothing is lost.** The result keeps every quarantined row's raw input, reason and, when it parsed, the candle. The caller can therefore log it, store it or show it in the daily report ("data-health incidents", S11b) without running validation again.

### Plan versus repo

1. **decimal.js is not installed.** D2 names it as the money type and §4 names `shared/decimal.ts`, but `package.json` has no `decimal.js`. Validation is the first code that compares prices, so this job adds it as a runtime dependency. This follows D2. D2 lets `number` be used only on prices "already validated", and the validator is what validates them.
2. **No Nest module.** §4 says each `src/` folder is a Nest module. S1a ships pure files only, with no `market-data.module.ts`, because no service wires them until S1b. This follows §4's own rule that calculation code is pure and Nest only wires it.
3. **`progress.md` test.** `test/unit/tooling/repo-files.spec.ts` asserts that the Next section names S1a. Once S1a is done, Next names S1b. This job updates that one assertion to the new fact. Its other assertions stay: S0 is complete, and no S0 line remains. This is an update of a recorded state, not a loosened test.

## Scope

### In

**`src/shared/decimal.ts`**

- Re-exports the `Decimal` class the app uses. Prefer a `Decimal.clone()`, so no module changes decimal.js's global configuration.
- `parseNonNegativeDecimal(value: unknown): Decimal | undefined`. It accepts only a string matching `^(0|[1-9][0-9]*)(\.[0-9]+)?$`: no sign, no exponent, no whitespace, no leading zeros other than a single `0`. Anything else returns `undefined`, and that includes a JS `number`.

**`src/market-data/normalizer.ts`**

- Intervals:
  - `type KlineInterval = '15m' | '1h' | '4h' | '1d'` (§2).
  - `INTERVAL_MS`, the interval lengths in ms.
- `normalizeEpoch(raw: unknown)`, the D12 epoch reader. On success it returns `{ ok: true, ms, unit: 'ms' | 'us', value }`, where `value` is the integer in its source unit. Otherwise it returns `{ ok: false }`.
  - **Accepted input:** a safe-integer `number`, or a string matching `^[1-9][0-9]{0,15}$`.
  - **ms:** the value lies in `[1483228800000, 4102444800000)`, which is 2017-01-01 to 2100-01-01 UTC.
  - **µs:** the value lies in `[1483228800000000, 4102444800000000)`. Then `ms = Math.floor(value / 1000)`.
  - The two ranges do not overlap, so no value is ambiguous. Anything outside both ranges is `{ ok: false }`, including 19-digit nanoseconds and the band between the ranges.
- `interface Candle`, readonly:
  - `symbol` and `interval`.
  - `openTimeMs` and `closeTimeMs`, as `number`.
  - `open`, `high`, `low`, `close`, `volume`, `quoteVolume`, `takerBuyBaseVolume` and `takerBuyQuoteVolume`, as `Decimal`.
  - `tradeCount`, as a `number` (a count, not money).
- `normalizeKlineRow(row: unknown, symbol: string, interval: KlineInterval)`. It returns `{ ok: true, candle }` or `{ ok: false, reason, openTimeMs? }`.
  - The row is the Binance kline array: `[openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]`.
  - REST JSON and the bulk spot CSV, once split into fields, both produce this shape.
  - The checks run in this order, and the first one that fails gives the reason:
    1. `malformed_row`: not an array of exactly 12 elements, checked with zod. Element 12 may hold any value and is ignored.
    2. `bad_timestamp`: `normalizeEpoch` fails on the open time or the close time.
    3. `timestamp_unit_mismatch`: the open and close times are in different units.
    4. `misaligned_open_time`: the open time, in its source unit, is not a multiple of the interval in that unit. A µs open time with a non-zero sub-millisecond remainder fails here.
    5. `bad_close_time`: the close time, in source units, is not exactly `open + interval − 1`.
    6. `bad_number`: one of the eight price and volume fields fails `parseNonNegativeDecimal`, or the trade count is not a non-negative safe integer (a `number`, or a string of digits).
    7. `non_positive_price`: open, high, low or close is zero.
    8. `ohlc_inconsistent`: `high < max(open, close)`, `low > min(open, close)`, or `low > high`, compared with `Decimal` methods.
    9. `volume_inconsistent`: `takerBuyBaseVolume > volume` or `takerBuyQuoteVolume > quoteVolume`.
  - `openTimeMs` is set on a failure whenever the open time was readable.

**`src/market-data/validator.ts`**

- `validateKlines(rows: readonly unknown[], options)`, where `options` is:
  - `symbol` and `interval`.
  - `range: { fromMs, toMs }`, half-open over open times.
  - `asOfMs`, the caller's clock. In replay it is the replay time.
  - `outlier: { window: number; maxRangeMultiple: number }`, required, with no default.
  - `history?: readonly Candle[]`.
- It returns a `KlineBatch`:
  - `candles`: accepted closed candles, strictly ascending by `openTimeMs`.
  - `checked`: closed candles that passed every hard check and the duplicate rule, ascending. These are the accepted candles plus the outlier-quarantined ones. A caller passes their tail as the next batch's `history`.
  - `open`: valid bars that have not closed by `asOfMs`. They are not quarantined, and they are not part of `candles`.
  - `quarantined`: `QuarantineRecord[]`, each holding `reason`, `raw` (the input row as given), `openTimeMs?` and `candle?` (present whenever the row parsed).
  - `missing`: `MissingRange[]`.
  - `unjudged`: the open times of accepted candles that the outlier rule could not judge yet.
  - `duplicatesCollapsed`: a count.
  - `outOfOrder`: a count.
- Batch rules, in order:
  1. **Row checks.** Each row goes through `normalizeKlineRow`, and failures are quarantined with its reason.
  2. **Time checks.** A bar with `openTimeMs > asOfMs` is quarantined as `future_bar`. A bar whose `openTimeMs` lies outside `[fromMs, toMs)` is quarantined as `outside_range`. `future_bar` is checked first.
  3. **Duplicates,** by `openTimeMs`, among rows that passed 1 and 2:
     - If every copy has equal values (Decimal `eq` and equal integers), one copy is kept, and each other copy adds 1 to `duplicatesCollapsed`.
     - If any copy differs, every copy is quarantined as `duplicate_conflict`, because the validator cannot know which copy is right.
     - A row quarantined in step 1 or 2 does not take part in this rule.
  4. **Order.** Output is always sorted. `outOfOrder` counts the rows with a readable open time whose open time is lower than that of the previous such row in input order. Arrival order belongs to the transport, not to the bar, and the bar's own open time fixes its slot. So out-of-order rows are sorted and counted, not quarantined.
  5. **Closed or open.** A bar is closed when `closeTimeMs < asOfMs`. Otherwise it goes to `open`.
  6. **Outliers.** These are judged over closed bars only, and causally.
     - Let `S` be `history` followed by this batch's closed bars that survived steps 1 to 3, ascending. `S` includes bars that are about to be flagged.
     - For a bar `t` in `S` with predecessor `p`, the true-range ratio is `r_t = (max(high_t, close_p) − min(low_t, close_p)) / close_p`, computed in `Decimal`.
     - A batch bar `t` is judged when `S` holds at least `window + 1` bars before it. It is an outlier when `r_t > maxRangeMultiple × median(r over the window bars immediately before t)`. The median of an even count is the mean of the two middle values.
     - An outlier is quarantined as `outlier`, and its record keeps the candle.
     - A bar that cannot be judged yet is accepted and listed in `unjudged`.
     - Flagged bars stay in `S` as reference points. A genuine level shift or a rise in volatility therefore flags at most the bars around it and never cascades.
     - A verdict depends only on bars at or before `t`, so there is no look-ahead.
  7. **Missing.** The expected slots are the aligned open times `t` in `[fromMs, toMs)` with `t + intervalMs ≤ asOfMs`. `missing` is every expected slot that has no accepted candle, merged into maximal half-open ranges `{ fromMs, toMs }` over open times. A slot whose bar was quarantined, including an outlier or a conflicting duplicate, is missing.
- `missingRanges(openTimesMs: readonly number[], { fromMs, toMs, intervalMs })` is the generic gap function behind step 7. It works for any regular series, such as the 5-minute metrics with their irregular gaps.
- `freshness(newestCloseMs: number | undefined, asOfMs: number, maxAgeMs: number)` returns one of:
  - `{ status: 'FRESH', ageMs }`
  - `{ status: 'STALE', ageMs }`
  - `{ status: 'UNKNOWN', reason: 'no_data' | 'clock_skew' }`

  The rules:
  - `ageMs = asOfMs − newestCloseMs − 1`.
  - The result is UNKNOWN `no_data` when `newestCloseMs` is undefined.
  - It is UNKNOWN `clock_skew` when `newestCloseMs ≥ asOfMs`.
  - It is FRESH when `ageMs ≤ maxAgeMs`, and STALE otherwise.
  - `freshnessBlocksEntries(f)` is true for every status but FRESH.
- **Argument errors throw. Data never throws.** These are programmer errors, and they throw a `TypeError` or `RangeError`:
  - an unknown interval
  - a `range.fromMs` or `toMs` that is not aligned, or `fromMs > toMs`
  - a non-safe-integer `asOfMs`
  - a `window` that is not an integer ≥ 1
  - a `maxRangeMultiple` that is not finite and > 0
  - a `maxAgeMs` that is not a safe integer > 0
  - a `history` that is not strictly ascending, holds a different symbol or interval, or does not end before `range.fromMs`

  No row content ever makes `validateKlines` throw.

**Dependency**

- `decimal.js` goes in `dependencies`, added with `pnpm add`, so the lockfile is a real resolution and not a hand edit.
- `pnpm-workspace.yaml` stays unchanged: decimal.js has no install script, and no new `allowBuilds` entry is needed.

**Tests and fixtures**

- New specs:
  - `test/unit/shared/decimal.spec.ts`
  - `test/unit/market-data/normalizer.spec.ts`
  - `test/unit/market-data/validator.spec.ts`
  - `test/unit/market-data/validator.property.spec.ts` (fast-check)
  - `test/unit/market-data/purity.spec.ts`
- Fixtures go under `test/fixtures/market-data/`. They are hand-written and synthetic, but they follow the documented formats:
  - a bulk-format spot CSV excerpt with µs timestamps
  - the same bars as a REST JSON array with ms timestamps
  - a 5-minute timestamp list with a 00:30 → 01:25 gap, standing in for the metrics data
- **Anchor:** 2026-10-01T00:00:00Z is `1790812800000` ms, which is `1790812800000000` µs. A 15m bar opening then closes at `1790813699999` ms, or `1790813699999999` µs.
- Nothing is fetched from Binance.

**Housekeeping**

- `progress.md`:
  - A Current state subsection `### Market data`. It names `normalizer.ts`, `validator.ts`, D12 µs/ms detection, the quarantine reasons, `missing` and `freshness`.
  - A Settlements subsection `### Market data`. It records the quarantine-is-a-result-type decision and the hand-offs below.
  - A `decimal.js` line in the Dependencies settlement.
  - The Done line `- [x] S1a ...`.
  - Next names S1b.
- `tests.json`: one entry per new spec, milestone `S1`.
- `repo-files.spec.ts`:
  - The S1a-as-next assertion moves to S1b (see "Plan versus repo" 3).
  - Add a test for the S1a Done line and the Market data settlement.

**Hand-offs**, recorded in the progress settlement:

- **S1b:**
  - quarantine persistence and its migration (human)
  - production values for `outlier.window` and `outlier.maxRangeMultiple`, from config, marked provisional
  - the row schemas for premium-index klines (signed values), funding and metrics (`create_time` datetime strings)
  - CSV header handling
- **S1c and S1d:** map the REST and WebSocket `k` payloads into the row shape or the `Candle`, and pass `history`.
- **S3 and S7a:** take `maxAgeMs` from config, and treat `freshnessBlocksEntries` and `missing` as UNKNOWN.
- **S10b:** emergency rules read outlier-quarantined candles explicitly from `quarantined[].candle`, so a real crash bar flagged as an outlier still reaches the exit side.

### Out

- **Persistence of any kind.** That means no `candles` or quarantine table, no migration, no `src/db/` change and no Drizzle schema. Those belong to S1b, which needs a human.
- **A Nest module or service for market data**, and any logging from these modules.
- **Fetching, sockets and clocks.** REST and WebSocket adapters, the bulk downloader, CHECKSUM verification and CSV file parsing belong to S1b, S1c and S1d. That covers `fetch`, `ws`, `undici`, `node:http`, `node:https`, `node:net` and any Binance URL. `Date.now()` is also out: the caller passes `asOfMs`.
- **Other payload types.** Premium-index, funding and metrics row schemas belong to S1b. The WebSocket kline object and bookTicker staleness belong to S1d and S8. Staleness here covers candle series only.
- **Production threshold values.** That covers the outlier window, the multiple and `maxAgeMs`. The functions take them as arguments with no defaults (master Part II §13: do not invent production limits).
- **Universe membership and symbol checks.** The symbol is a caller argument (D3, S1c).
- **Warm-up rules for regimes,** which belong to S3. **Filling or interpolating missing bars:** never done.
- **The S1 "Done when"** (history loaded from 2022-01 and a 24h live run). It applies when S1d merges.
- **Protected and job-owned files:** `src/config/`, `src/db/`, `factory/`, `.claude/`, `CLAUDE.md` and the plans.

## Acceptance criteria

Everything runs under `pnpm test`, with no database, no network and no Docker.

**Decimal (`test/unit/shared/decimal.spec.ts`)**

1. `parseNonNegativeDecimal` returns a `Decimal` equal to the input for `"0"`, `"0.00000000"`, `"60000.01000000"` and `"1.000000000000000001"`. It returns `undefined` for each of these:
   - `"-1"`, `"+1"`, `"1e5"`, `" 1"`, `"1 "`, `"01"`, `"1."`, `".5"`, `""`, `"NaN"`, `"Infinity"`
   - the numbers `1` and `60000.01`
   - `null`, `undefined`, an object
2. **Property:** for any non-negative decimal string of up to 30 significant digits that the generator builds, `parseNonNegativeDecimal(s).toFixed()` equals the canonical form of `s`, with trailing fractional zeros trimmed. No precision is lost.

**Epoch reading, D12 (`normalizer.spec.ts`)**

3. `normalizeEpoch(1790812800000)` and `normalizeEpoch("1790812800000")` return `ms 1790812800000`, unit `ms`. The µs forms `1790812800000000` and `"1790812800000000"` return the same `ms`, unit `us`.
4. **Property:** for every integer `m` in the ms range, `normalizeEpoch(m)` is `{ ms: m, unit: 'ms' }`. For every `r` in `[0, 999]`, `normalizeEpoch(m * 1000 + r)` is `{ ms: m, unit: 'us' }`. No value is accepted as both units.
5. These are all rejected:
   - 1483228799999 and 4102444800000, the ms range ends
   - the µs range ends
   - 10^13 and 10^15 − 1, the band between the ranges
   - a 19-digit nanosecond string
   - `1790812800000.5`, `-1`, `0`
   - `"01790812800000"`, `"1790812800000 "`, `"0x1A"`
   - `Number.MAX_SAFE_INTEGER + 2`
   - `null` and a bigint
6. **Same bar in both units.** The fixture bar in µs (bulk CSV fields) and in ms (REST JSON) normalize to `Candle`s that are deep-equal field by field, with Decimals compared by `eq`. Its `openTimeMs` is `1790812800000` and its `closeTimeMs` is `1790813699999`.

**Row checks (`normalizer.spec.ts`)**

7. Each reason in the ordered list (`malformed_row` to `volume_inconsistent`) has at least one fixture row that yields exactly that reason. A row with several faults yields the first in list order. Cases:
   - 11 and 13 elements give `malformed_row`.
   - µs open with ms close gives `timestamp_unit_mismatch`.
   - A 15m open time of `:07` gives `misaligned_open_time`, as does a µs open time ending in `…000001`.
   - Close = open + interval and close = open + interval − 2 both give `bad_close_time`.
   - A price given as the JS number `60000.01` gives `bad_number`, as does a trade count of `-1` or `"1.5"`.
   - `low = "0"` gives `non_positive_price`.
   - `high` below `close` gives `ohlc_inconsistent`.
   - Taker-buy base above volume gives `volume_inconsistent`.
8. **Property, OHLC.** Generated candles with `0 < low ≤ min(open, close) ≤ max(open, close) ≤ high` and taker volumes within their totals are accepted, for every interval and both units. Each single mutation that breaks one inequality yields `ohlc_inconsistent` or `volume_inconsistent`, whichever matches. Zero-volume bars with `o = h = l = c` are accepted.
9. **Decimal, not float.**
   - All eight money fields of an accepted `Candle` are `Decimal` instances.
   - `low = "1.00000000000000001"` with `open = "1"` is `ohlc_inconsistent`. A float compare would accept it.
   - The 1D, 4H, 1H and 15M alignment and close-time rules hold for every interval, in both units.

**Batch rules (`validator.spec.ts`)**

10. **Duplicates.**
    - Two identical rows for one slot give one candle and `duplicatesCollapsed = 1`. The ms and µs forms of the same bar count as identical.
    - Two rows for one slot that differ only in the 18th significant digit of `close` are both quarantined as `duplicate_conflict`, and the slot is in `missing`.
    - A malformed row sharing a slot with a valid row does not stop the valid row being accepted.
11. **Order.** Fixture rows given in reverse produce the same `candles`, `missing` and `open` as in ascending order, with `outOfOrder` equal to rows − 1. Ascending input gives `outOfOrder = 0`.
12. **Range and future.**
    - A row before `fromMs` or at or after `toMs` is `outside_range`.
    - A row with `openTimeMs > asOfMs` is `future_bar`. A row in a slot that is also outside the range is still `future_bar`.
    - A bar with `closeTimeMs ≥ asOfMs` and `openTimeMs ≤ asOfMs` is in `open`. It is not in `candles`, `quarantined` or `missing`.
13. **Missing.**
    - The metrics-style fixture (5m, rows at 00:00 to 00:30 and from 01:25) passed to `missingRanges` gives exactly one range, `[00:35, 01:25)`, in ms.
    - An empty batch over a closed range gives one range covering it.
    - Leading and trailing gaps inside the range are reported.
    - Expected slots stop at `asOfMs`, so no slot later than the last closed one is ever missing.
14. **Outliers, fixed cases** (window 4, multiple 5):
    - A series of calm bars followed by one bar whose true range is 20 times the median is quarantined as `outlier`. Its record carries the `candle`, and its slot is in `missing`.
    - A genuine level shift (one large bar, then calm bars at the new level) flags at most the shift bar and the bar right after it. Every later bar is accepted.
    - The first `window + 1` bars of a series with no `history` are accepted and listed in `unjudged`.
    - With `window + 1` bars of `history`, no batch bar is unjudged.
15. **Argument errors throw.** Each argument error in Scope throws, one case each. Each throwing case names the argument in the error message.

**Properties (`validator.property.spec.ts`, fast-check, at least 500 runs each unless noted)**

16. **Every row is accounted for.**
    - For arbitrary rows, a mix of valid generated bars, mutated bars, duplicates and `fc.anything()`, `validateKlines` does not throw.
    - `candles.length + open.length + quarantined.length + duplicatesCollapsed === rows.length`.
17. **Explicit missing data.** The open times of `candles` and the slots of `missing` are disjoint, and their union is exactly the expected slot set from rule 7.
18. **Output order.** `candles` and `checked` are strictly ascending by `openTimeMs`, and `candles` is a subset of `checked`. Every candle's `openTimeMs` lies in `[fromMs, toMs)`, and its `closeTimeMs` is below `asOfMs`.
19. **Order invariance.** Any permutation of the input gives the same `candles`, `checked`, `open`, `missing`, `unjudged` and `duplicatesCollapsed`. It also gives the same multiset of `(reason, openTimeMs)` in `quarantined`.
20. **No look-ahead.**
    - For a generated closed series and any index `i`, a bar's outlier verdict (accepted, `outlier` or unjudged) is the same whether or not the bars after `i` are present, and whatever their values.
    - A bar in the batch that closes at or after `asOfMs` never appears in `candles` or `checked`.
21. **Live and replay agree (D13).** Take a generated series and any split slot `s`. Validate `[from, to)` at once. Separately, validate `[from, s)`, then validate `[s, to)` with `history` set to the first call's `checked`. Both give the same accepted set and the same `outlier` set.
22. **Freshness.**
    - `freshness` is FRESH exactly when `newestCloseMs < asOfMs` and `asOfMs − newestCloseMs − 1 ≤ maxAgeMs`. Otherwise it is STALE or UNKNOWN, with the reasons from Scope.
    - With `newestCloseMs` fixed, raising `asOfMs` never turns STALE into FRESH.
    - `freshnessBlocksEntries` is false only for FRESH.
    - Boundary cases are pinned by example: age exactly `maxAgeMs` is FRESH, `maxAgeMs + 1` is STALE, and `newestCloseMs = asOfMs` is `clock_skew`.
23. **Time zone.** `validateKlines` over the fixture gives deep-equal results with `process.env.TZ` set to `UTC`, `Europe/Ljubljana` and `Pacific/Chatham`. The test restores `TZ` afterwards.

**Purity and boundaries (`purity.spec.ts`, a text scan)**

24. **D13.** `src/market-data/normalizer.ts`, `src/market-data/validator.ts` and `src/shared/decimal.ts` import only `decimal.js`, `zod` and relative modules under `src/shared/` or `src/market-data/`. They never import:
    - `@nestjs/*`, `drizzle-orm`, `pg`, `nestjs-pino` or `pino`
    - anything under `src/db/` or `src/config/`
    - `node:fs`, `node:http`, `node:https`, `node:net`, `ws` or `undici`
25. **No hidden inputs.** The same three files contain no `Date.now`, `new Date`, `Math.random`, `process.env`, `fetch(` or `console.`.
26. **No live endpoints.** No file under `src/market-data/`, `test/unit/market-data/` or `test/fixtures/market-data/` contains `http://`, `https://`, `wss://`, `binance.com` or `binance.vision`.

**Dependency and housekeeping**

27. **decimal.js.**
    - `package.json` `dependencies` has `decimal.js`, and `pnpm-lock.yaml` resolves it.
    - `pnpm install --frozen-lockfile` succeeds.
    - The existing `dependencies.spec.ts` (D9 forbidden packages, esbuild override, workspace settings) and `no-telemetry.spec.ts` pass unchanged.
28. **`repo-files.spec.ts`:**
    - `progress.md` matches `/^- \[x\] S1a /m`.
    - Next matches `/^- S1b /m`, still contains `S0 is complete`, and has no `- S0` line.
    - Current state has a `### Market data` subsection naming `` `normalizer.ts` ``, `` `validator.ts` ``, `D12` and `` `freshness` ``.
    - Settlements has a `### Market data` subsection containing `S1b` and `S10b`.
    - The Dependencies settlement contains `` `decimal.js` ``.
    - Every other existing assertion in the file is unchanged.
29. **`tests.json`** lists each new spec exactly once with milestone `S1`. The existing "lists every spec file exactly once" and "lists only files that exist" tests pass.
30. **Whole job.**
    - `pnpm test`, `pnpm lint` and `pnpm typecheck` pass.
    - No test is deleted, skipped or loosened. The one updated assertion is the one in criterion 28.
    - Nothing under `src/db/`, `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans or `docker-compose.yml` changes.
31. **[human]** Run the normalizer over the real `data.binance.vision` BTCUSDT 15m spot file for 2026-10-01: download it by hand and verify its CHECKSUM, outside the factory. The result is 96 accepted candles, all with unit `us`, with nothing quarantined and nothing missing. This confirms that the synthetic µs fixture matches the real format D12 describes. It is a smoke check: factory agents cannot fetch the file, and no merge criterion depends on it.

## Rules that apply

- **Money is `Decimal`.** Prices and volumes are parsed from strings straight into `Decimal` and compared with `Decimal` methods. A JS `number` in a money field is rejected, not converted. Criteria 1, 2, 9 and 10 prove it.
- **One implementation (D13).** The functions are pure: no Nest, DB, network, clock, environment or logging. The live/replay split property (criterion 21) and the import scan (criterion 24) guard this.
- **No look-ahead.** The outlier verdict for bar *t* uses only bars ≤ *t*. Open bars are never in `candles`. Criteria 20 and 21 prove it.
- **UTC everywhere. Invalid data is quarantined, never silently used.**
  - Epoch ms only. No local-time API is used.
  - Every row lands in exactly one bucket (criterion 16).
  - Missing slots are listed and never filled (criterion 17).
- **UNKNOWN blocks entries.** Stale data, no data and clock skew are not FRESH, and `freshnessBlocksEntries` is true for them. Quarantined slots count as missing, so S3 and S7a can treat them as UNKNOWN.
- **Exits are always allowed.** Nothing here blocks an exit. Outlier-quarantined candles stay readable in `quarantined[].candle`, so a real crash bar is never hidden from the emergency rules (S10b hand-off).
- **No invented risk numbers** (master Part II §13). The outlier window, the outlier multiple and `maxAgeMs` are required arguments with no defaults. The values in the tests are fixtures, not policy.
- **External content is data (Rule 11).** Raw rows are only checked against a schema and parsed. They are never evaluated, interpolated into code, or treated as instructions. The `raw` field is kept as data.
- **No secrets and no real endpoints (D9, factory rules).** Fixtures only, with no Binance URL anywhere (criterion 26). No exchange-client package is added, and `dependencies.spec.ts` keeps guarding that.
- **Never delete or skip a test to go green.** The only changed existing assertion is the next-item line in `repo-files.spec.ts`, which records a new fact (criterion 28). Write tests first: every criterion fails on today's `main`, because none of these files exist yet.

## Open decisions

- **No SLICE_1_PLAN §11 item governs this job.** §11.5 (the universe list) does not matter here, because the symbol is a caller argument.
- **Choices made here, from the plan's intent:**
  1. **Quarantine is a pure result type, with no table.** The reasons are in "Quarantine: result type, not a table". S1b decides storage, and that needs a human.
  2. **Out-of-order rows are sorted and counted, not quarantined.** The bar's own open time fixes its slot, so sorting loses nothing, and the count keeps it visible.
  3. **Conflicting duplicates quarantine every copy, and the slot becomes missing.** Identical duplicates collapse to one.
  4. **The outlier rule.** It is a true-range ratio against the median of the previous `window` ratios. It is causal, computed in `Decimal`, and flagged bars stay as reference points so a regime change does not cascade. The thresholds come from the caller. Production values are a later, research-backed choice (S1b and S2, fit on the train split only), not this job's.
  5. **Staleness is an age threshold** that the caller supplies (`maxAgeMs`). §8 sets `reject_on_stale_data: true` but gives no number, so S7a and S11a take it from config.
