VERDICT: PASS

## Findings

No blocking findings. I checked the math myself rather than relying on the tests. The loader, validator and property specs also pass offline (3 files, 114 tests).

### Checked by hand

- **Period ranges.** 2026-01-01 is day 20454 since the epoch (56 × 365 + 14 leap days). 2026-10-01 is 273 days later, day 20727, so `fromMs` = 20727 × 86400000 = 1790812800000. The last 15m open is `toMs − 900000` = 1790898300000. `binance-vision.ts:107-117` builds ranges with `Date.UTC` only, so they do not depend on TZ.
- **µs to ms (D12).** `normalizeEpoch` floors µs to ms with exact integer arithmetic. The close of `…199999999` µs becomes 1790899199999 ms, which matches criterion 13 and 34. `timeUnits` (`bulk-csv.ts:95`) counts `us`, `ms` and `unreadable` per row and does not guess a unit for the whole file. Mixed files from 2025 and earlier are handled per row.
- **Warm-up.** In `validator.ts:212`, `k < window + 1` means window 4 with no history leaves 5 bars unjudged (criterion 14). `storedRows` (`bulk-loader.ts:230`) maps them to `outlierChecked = false`.
- **Criterion 24.** The reference ratios are 1/100 and 3/100, so the median is 0.02 and the threshold at multiple 5 is 0.10. A bar at 111 has ratio 0.11 against slot 3's close and is flagged. A bar at 109 has 0.09 and is accepted. The test computes both values itself with `Decimal`, not through the validator.
- **Criterion 17.** The 96 slots minus 6 missing give 90 lines. Six extra lines (slot 10, slot 20, two at slot 30, slot 40, slot 50) and one identical duplicate at slot 80 bring the total to 97. Accepted 90 + quarantined 6 + duplicates collapsed 1 = 97, which balances. The slot-40 spike has true range (65000 − 59999.50) / 60000 ≈ 0.083 against a median of 1/60000, so it is flagged. `missing` is exactly slots 10, 20, 30, 40, 50 and 60.
- **No look-ahead.** `planFiles` (`bulk-loader.ts:183`) refuses any period with `range.toMs > asOfMs` before any GET. Outlier verdicts are causal: bar k uses only `ratios[k-window..k-1]`. `history` comes only from earlier files, and the validator still checks `history.at(-1).closeTimeMs < range.fromMs`.
- **Fixtures.** The 96-row day and the property series are built by integer arithmetic in `test/fixtures/market-data/bulk.ts` (an LCG walk and `price()`), not by the code under test. Expected times and ratios come from the spec or are computed inside the test.
- **Determinism.** The same files and inputs give the same output. There is no clock inside the pipeline (`asOfMs` is read once by the CLI) and no concurrency.
- Look-ahead in features, test-split use, EV and the fill model are not in this change. The outlier inputs are required flags with no default and are echoed as `provisional: true`.

### Deviation 2: history across files. Accepted.

`bulk-loader.ts:503-506` keeps `[...history, ...checked].slice(-max(window + 1, checked.length))`. My proof that this matches one batch over the whole range (D13):

- With `H = history.length`, batch bar `H + j` reads `ratios[H + j − window .. H + j − 1]`.
- When `H ≥ window + 1`, the smallest index read is at least 1. The placeholder `ratios[0] = 0` for the trimmed series head is therefore never read, and every ratio used has its real predecessor in the series. The verdicts are identical to a single batch.
- Trimming happens only when the accumulated total exceeds `keep ≥ window + 1`. Below that, the history holds every checked bar since the run started, which is exactly the single-batch prefix. Once `H ≥ window + 1`, it stays there.
- A failed file (`checked` undefined) leaves the history unchanged. This matches a single batch where that file's bars are absent, and criterion 18's third case pins it.
- The deviation also fixes a second case of the spec's literal rule. If a file reaches validation but every row is quarantined (`checked = []`), the literal rule would hand the next file an empty history and force a fresh warm-up. Here the next file keeps the last `window + 1` bars.

The 200-run property exercises this with windows up to 30 over 24-bar 1h days, which covers `window ≥ bars per file`, together with gaps, spikes, malformed rows and flat runs. The 4h case pins the trim exactly. Criterion 18's first case still holds literally for 15m days: when the previous file has at least `window + 1` bars, the history equals that file's `checked`.

Recommendation for the orchestrator: update the spec wording of step 5 and Scope item 4 to the accumulated rule, so the spec and the code agree.

### Deviation 3: money stored as `Decimal.toFixed()`. Accepted.

I checked the decimal.js clone with default settings:

| Input | `toFixed()` |
|---|---|
| `60000.00000000` | `60000` |
| `0.00000000` | `0` |
| `1e-27` | the full `0.000…001` |
| 30 integer digits + 21 fraction digits | unchanged |
| `-0` | `0` |

`toFixed()` with no argument does not round and never uses exponent notation, so the stored `numeric` (no precision) equals the parsed value exactly. `Decimal.eq` round trips, idempotency and the 18th-digit conflict test all hold. Only the source's trailing zeros are lost. That scale carries no value: tick and step sizes come from exchangeInfo (S1c), and the verified `sha256` in the summary is the record of where the data came from.

Recommendation, not blocking: add one line to the S3 / S1c hand-off saying that a stored scale is not a precision, so no later job reads tick size from `numeric` scale.

### Notes, not blocking

1. **Bars at a run boundary can change bucket between runs.**
   - Each run's first `window + 1` bars are unjudged (`bulk-loader.ts:500`, history starts empty by design).
   - Suppose run A judges bar X with full history and flags it (quarantine `outlier`, no candle). Run B then starts on X's day. X is now in warm-up, so `candle-store.ts:127-158` inserts it into `candles` with `outlier_checked = false`.
   - The reverse case leaves a stored candle and an `outlier` quarantine row for the same slot.
   - Both outcomes follow the spec ("Out: seeding history from the database"; Open decision 3, the incident log). `outlier_checked = false` marks the first case.
   - Recommendation: say this explicitly in the `progress.md` S3/S7a hand-off. A slot is outlier-clean only when `outlier_checked = true` and no `outlier` row exists for it. Readers must treat `outlier_checked = false` as unverified, never as accepted.
   - Recommendation for the human: run the 2022 backfill as one run per symbol and interval with monthly files, so only the first `window + 1` bars of 2022-01 are unjudged.
2. **The quarantine key has no content identity.**
   - `market_data_quarantine` is keyed by `(source_file, row_index, reason)` and inserted with `ON CONFLICT DO NOTHING` (`candle-store.ts:210-230`).
   - If Binance republishes a file under the same name, a changed row at the same index and reason is counted in the summary (`storedConflicts`, `quarantined`), but its new `raw` is not recorded. The first incident row stays.
   - The stored candle is still never overwritten, so this is not a data-safety leak. It is a gap in the incident log.
   - Optional for a later job: key on the archive's `sha256`, or add it as a column.
3. **`sameMarketFields`** (`candle-store.ts:48-65`) repeats the field list of the validator's private `sameValues`. It compares a database row against a `Candle` and is not live/replay logic, so D13 is not breached. If a field is ever added, both lists need it. A shared field list would prevent drift.

### Files

- `local-trading-agent-backend/src/market-data/bulk-loader.ts`
- `local-trading-agent-backend/src/market-data/candle-store.ts`
- `local-trading-agent-backend/src/market-data/bulk-csv.ts`
- `local-trading-agent-backend/src/market-data/binance-vision.ts`
- `local-trading-agent-backend/src/market-data/validator.ts` (unchanged)
- `local-trading-agent-backend/test/unit/market-data/bulk-loader.property.spec.ts`
- `local-trading-agent-backend/test/unit/market-data/validator.spec.ts`
