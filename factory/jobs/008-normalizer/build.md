# Build: 008-normalizer (S1a)

Branch `factory/008-normalizer`, commit `3ca6158` on top of `ce5fe17`. Worktree `.worktrees/008-normalizer`.

`pnpm test` (33 files, 1016 tests), `pnpm lint`, `pnpm typecheck` and `pnpm build` all pass. `pnpm install --frozen-lockfile` succeeds. No Docker, no network beyond the npm registry for `pnpm add`, and no Binance endpoint.

## What changed

New source (pure, no Nest/DB/network/clock/env/logging):

- `local-trading-agent-backend/src/shared/decimal.ts`: `Decimal`, a `DecimalJs.clone({ defaults: true })`, so the global decimal.js config is never touched or inherited. `parseNonNegativeDecimal(value: unknown)` takes strings matching `^(0|[1-9][0-9]*)(\.[0-9]+)?$` only.
- `local-trading-agent-backend/src/market-data/normalizer.ts`: `KlineInterval`, `INTERVAL_MS`, `isKlineInterval`, `intervalMs`, `normalizeEpoch`, `Candle`, `ROW_REJECT_REASONS`, `normalizeKlineRow`. Shape is checked with zod (`z.array(z.unknown()).length(12)`). The µs to ms step uses exact integer arithmetic, `(v - v % 1000) / 1000`.
- `local-trading-agent-backend/src/market-data/validator.ts`: `validateKlines`, `missingRanges`, `freshness`, `freshnessBlocksEntries`, and the types `KlineBatch`, `QuarantineRecord`, `QuarantineReason`, `MissingRange`, `ValidateKlinesOptions`, `OutlierOptions`, `Freshness`.

Dependency:

- `decimal.js` **10.6.0** in `dependencies`, pinned exactly (`"decimal.js": "10.6.0"`), added with `pnpm add decimal.js@10.6.0 --save-exact`. The lockfile diff is that one importer entry, one package entry and one snapshot (8 lines). decimal.js has no dependencies and no install script. `pnpm-workspace.yaml` is unchanged. Nothing else was installed.
- `pnpm audit --prod`: **No known vulnerabilities found.** A full `pnpm audit` still shows only the known dev-only `minimatch` GHSA-g3hv-75wg-m249 already recorded in `progress.md`.

Tests and fixtures:

- `test/unit/shared/decimal.spec.ts`, `test/unit/market-data/normalizer.spec.ts`, `validator.spec.ts`, `validator.property.spec.ts` and `purity.spec.ts`.
- `test/fixtures/market-data/`:
  - `btcusdt-15m-2026-10-01.csv`: 8 bulk-format lines with µs times and no header.
  - `btcusdt-15m-2026-10-01.rest.json`: the same 8 bars as REST JSON with ms times, numbers for times and the count, strings for money.
  - `metrics-5m-create-times.txt`: a `create_time` header, then UTC datetime strings from 00:00 to 00:30 and from 01:25 to 02:00.
  - `klines.ts`: the loaders and row helpers.
  - All fixtures are synthetic and hand-written. Nothing was fetched.

Housekeeping:

- `progress.md`:
  - a Current state `### Market data` subsection
  - a Settlements `### Market data` subsection (the quarantine decision, the choices made, and the hand-offs to S1b, S1c/S1d, S3/S7a and S10b)
  - a `decimal.js` bullet in Dependencies
  - the `- [x] S1a` Done line
  - Next now names S1b
- `tests.json`: five new entries with milestone `S1`, and the `repo-files.spec.ts` entry's `covers` text updated.
- `test/unit/tooling/repo-files.spec.ts`: the one assertion `names S1a as next` became `names S1b as next`, with the same three expectations otherwise. A new `describe('S1a')` adds the Done line, Market data current-state, settlement and `decimal.js` checks.

## Acceptance criteria

| # | Proved by |
|---|---|
| 1 | `decimal.spec.ts` › "parseNonNegativeDecimal (criterion 1)": the four accepted strings, the 11 rejected strings, the numbers `1` and `60000.01`, `null`, `undefined` and an object. |
| 2 | `decimal.spec.ts` › "no precision is lost (criterion 2)". The generator builds an integer part of up to 15 digits and an optional fraction of up to 15 (≤30 significant digits). `toFixed()` equals the canonical form with trailing fractional zeros trimmed. 1000 runs. |
| 3 | `normalizer.spec.ts` › "normalizeEpoch, D12 (criterion 3)". Also checks that the anchor equals `Date.UTC(2026, 9, 1)`. |
| 4 | `normalizer.spec.ts` › "normalizeEpoch properties (criterion 4)": the ms range is identity, `m*1000+r` reads as `us`, and over all safe integers the unit follows the range and no value fits both. 1000 runs each. |
| 5 | `normalizer.spec.ts` › "normalizeEpoch rejects (criterion 5)": every listed case. The 19-digit ns value is tested both as a string and as a number. A test also pins the four range ends as accepted. |
| 6 | `normalizer.spec.ts` › "the same bar in both units (criterion 6)": the first bar and all 8 bars, CSV against REST, field by field with Decimals compared by `eq`. Times are `1790812800000` and `1790813699999`. |
| 7 | `normalizer.spec.ts` › "row checks, one reason each (criterion 7)": every listed case, a "covers every reason in the list" check, and eight "several faults" cases showing first-in-order wins. |
| 8 | `normalizer.spec.ts` › "OHLC and volume properties (criterion 8)": consistent bars are accepted for every interval and both units. Five single-inequality mutations each give their reason. Zero-volume `o=h=l=c` is accepted. 500 to 1000 runs. |
| 9 | `normalizer.spec.ts` › "Decimal, not float (criterion 9)": the money fields are `Decimal` instances. `low = "1.00000000000000001"` with `open = "1"` is `ohlc_inconsistent`, and the test also asserts that a float compare would accept it. Alignment and close-time rules are tested per interval and per unit. |
| 10 | `validator.spec.ts` › "duplicates (criterion 10)". |
| 11 | `validator.spec.ts` › "order (criterion 11)". |
| 12 | `validator.spec.ts` › "range and future (criterion 12)". |
| 13 | `validator.spec.ts` › "missing (criterion 13)": the metrics gap is `[00:35, 01:25)`, which is `{1790814900000, 1790817900000}`. |
| 14 | `validator.spec.ts` › "outliers (criterion 14, window 4, multiple 5)", plus "the outlier rule, pinned at its boundary" (described after this table). |
| 15 | `validator.spec.ts` › "argument errors throw (criterion 15)": one case for each Scope error, each asserting `TypeError`/`RangeError` and the argument name in the message. Separate tests cover the `freshness` `maxAgeMs` and `asOfMs` cases, `missingRanges`' `intervalMs`, and "no row content throws". |
| 16 | `validator.property.spec.ts` › "every row is accounted for (criterion 16)". Rows mix valid bars in both units, mutated bars (a field replaced by `fc.anything()` or junk, truncated, or 13 elements), `fc.anything()`, and repeated copies. |
| 17 | `validator.property.spec.ts` › "explicit missing data (criterion 17)", plus a maximality check. |
| 18 | `validator.property.spec.ts` › "output order (criterion 18)". |
| 19 | `validator.property.spec.ts` › "order invariance (criterion 19)", using `fc.shuffledSubarray` over the full length. |
| 20 | `validator.property.spec.ts` › "no look-ahead (criterion 20)": verdicts are unchanged when later bars are cut off or replaced, and an unclosed bar is never in `candles` or `checked`. A self-check confirms the generators actually produce outliers (>20 of 300 samples). |
| 21 | `validator.property.spec.ts` › "live and replay agree, D13 (criterion 21)", run over the mixed-row generator (junk, duplicates, conflicts) and any `asOfMs`, not only clean series. |
| 22 | `validator.property.spec.ts` › "freshness (criterion 22)", plus the pinned boundary cases in `validator.spec.ts` › "freshness (criterion 22, pinned cases)". |
| 23 | `validator.property.spec.ts` › "time zone (criterion 23)": REST and CSV fixtures under the three zones. It asserts that local hours differ across the zones, so the zone change really took effect, and restores `TZ` in `afterEach`. |
| 24 | `purity.spec.ts` › "… (criteria 24 and 25)": an import specifier allow-list over `from`, side-effect `import`, `import()` and `require()`, plus explicit forbidden-name needles. The scanner itself is tested. |
| 25 | Same block: `Date.now`, `new Date`, `Math.random`, `process.env`, `fetch(` and `console.`. The needles are built from parts. |
| 26 | `purity.spec.ts` › "no live endpoints (criterion 26)": over `src/market-data/`, `test/unit/market-data/` and `test/fixtures/market-data/`, with the needles built from parts so the spec does not match itself. It asserts the scan covers the expected files. |
| 27 | `package.json` and `pnpm-lock.yaml` as above. `pnpm install --frozen-lockfile` passes. `dependencies.spec.ts` and `no-telemetry.spec.ts` pass unchanged. |
| 28 | `repo-files.spec.ts` › "says S0 is complete and names S1b as next" and the `describe('S1a')` block. No other existing assertion changed. |
| 29 | `tests.json` lists the five new specs once each with `S1`. The existing "lists every spec file exactly once" and "lists only files that exist" tests pass. |
| 30 | All four commands pass. No test was deleted, skipped or loosened. `git diff ce5fe17 --stat` touches nothing under `src/db/`, `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans or `docker-compose.yml`. |

Extra tests beyond the criteria, in "the outlier rule, pinned at its boundary" (window 1 or 2, multiple 1), pin the formula exactly:

- the denominator is the previous close
- a gap up and a gap down from the previous close count as range
- the comparison is strict `>`
- an even window takes the mean of the two middle ratios

I added these after hand-mutating the source: `.div(bar.close)`, dropping `Decimal.max(high, prevClose)`, an upper-middle median, and `gte` all survived the criterion tests alone. With these tests every one of those mutants fails. Other mutants I tried were also killed:

- look-ahead in the median window
- `<=` in the closed check
- off-by-one in the expected slots
- always collapsing duplicates
- the `window` threshold
- `>=` in the future check
- `Math.round` in the µs conversion
- dropping the `outOfOrder` and `duplicatesCollapsed` counters
- a `-0` trade count

`low > high` is the one surviving mutant. It is logically implied by the other two OHLC inequalities, but the spec lists it, so it stays.

## `[human]` criteria

- **31** is not proved here. Run the normalizer over the real `BTCUSDT-15m-2026-10-01` spot file after downloading it by hand and verifying its CHECKSUM. Expect 96 accepted candles, all `unit: 'us'`, with nothing quarantined and nothing missing. A sketch: split each line on `,`, then call `validateKlines(rows, { symbol: 'BTCUSDT', interval: '15m', range: { fromMs: 1790812800000, toMs: 1790899200000 }, asOfMs: 1790899200000, outlier: { window: <any>, maxRangeMultiple: <large> } })`. If the outlier fixture values happen to flag a real bar, use a large multiple for this format check. Units come from `normalizeEpoch` on column 0.

## For the reviewer

- **Test-first ordering.** I wrote the source modules first and the specs straight after, not strictly red-first. Every criterion test fails on `main`, because the modules do not exist there. The mutation pass above stands in for the "watch it fail" step.
- **Trade count as a string.** It accepts `^[0-9]+$`, read literally from "a string of digits", so `"007"` reads as 7, unlike the stricter money regex. Say if it should reject leading zeros.
- **Row-check failures carry no `candle`.** I read "present whenever the row parsed" as "`normalizeKlineRow` succeeded". So `ohlc_inconsistent` and the other row-check failures have no candle; `future_bar`, `outside_range`, `duplicate_conflict` and `outlier` do. This is recorded in the progress settlement.
- **An outlier slot with identical duplicates** produces one `outlier` record, holding the first copy's `raw` in input order. The other copies count in `duplicatesCollapsed`, so the accounting identity holds. Which copy's `raw` is kept depends on input order; criterion 19 only compares `(reason, openTimeMs)`.
- **Decimal precision.** The clone keeps decimal.js defaults: 20 significant digits and `ROUND_HALF_UP` for arithmetic. Parsing and comparisons are exact. Only the outlier ratio and median divide, so a ratio within about 1e-20 relative of the threshold could round either way. It is deterministic, so live and replay still agree. Raise `precision` in `shared/decimal.ts` if that matters.
- **The predecessor in the true range** is the previous bar in `S`, even across a gap of missing slots, as the spec says. After a gap the ratio is measured against an older close.
- **Extra argument checks** beyond the Scope list:
  - `freshness` throws on a non-safe-integer `asOfMs` or `newestCloseMs`.
  - `missingRanges` throws on non-safe-integer bounds, `intervalMs <= 0` or `fromMs > toMs`.
  - `normalizeKlineRow` throws `TypeError` on an unknown interval.
- **`missingRanges` caps a trailing range at `toMs`** when `toMs` is not on the grid, so a range never extends past the requested end. `validateKlines` always passes an aligned end.
- **`history` validation** checks symbol, interval, strict ascent and `last.closeTimeMs < range.fromMs`. It does not re-validate history candles' prices.
- I ran `prettier --write` on the new and changed spec/source files only.
