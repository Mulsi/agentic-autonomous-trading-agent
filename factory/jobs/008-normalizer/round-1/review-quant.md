VERDICT: PASS

## Findings

No blocking findings. I read `spec.md`, `build.md` and the whole diff `main...HEAD` (commit `3ca6158`). I checked the math by hand and with a scratch probe that wrote nothing into the repo. The five market-data and decimal specs pass locally: 292 tests.

### What I checked and found correct

- **D12 epoch reading** (`src/market-data/normalizer.ts:36-73`):
  - The range ends are correct. `Date.UTC(2017,0,1) = 1483228800000` and `Date.UTC(2100,0,1) = 4102444800000`.
  - `US_END = 4.1e15`, which is below `MAX_SAFE_INTEGER`, so every accepted µs value is an exact integer.
  - `(v - v % 1000) / 1000` is an exact floor for positive values.
  - The ms and µs ranges cannot overlap, and the string regex shuts out 19-digit nanosecond values.
  - A µs close time `open_us + step_us - 1` floors to `open_ms + step_ms - 1`, so the ms and µs forms give the same `closeTimeMs`. The duplicate rule depends on this.
- **Alignment and close time** (`normalizer.ts:167-173`):
  - Both checks run in source units, with `step × 1000` for µs. The largest µs modulus is `86_400_000_000` for 1d, which is exact.
  - A µs open time with a sub-millisecond remainder fails the alignment check.
  - The 1d and 4h grids are epoch-aligned, so they match Binance's UTC bar boundaries.
- **Money:**
  - `parseNonNegativeDecimal` builds `Decimal` from the string, and decimal.js does not round in the constructor. The probe checked a 51-digit string: `toFixed()` round-trips exactly.
  - A JS `number` is rejected.
  - Every OHLC and volume comparison uses `Decimal` methods. `Decimal.max` and `Decimal.min` return copies that are not rounded.
- **Closed and open bars, look-ahead** (`validator.ts:285-286`, `308-314`):
  - A bar is closed when `closeTimeMs < asOfMs`, which is `t + step ≤ asOfMs`. The expected-slot rule uses the same condition, so a bar still open at `asOfMs` is never in `candles`, `checked` or `missing`.
  - A bar with `openTimeMs == asOfMs` goes to `open`, which is correct.
  - `expectedSlots = min((to−from)/step, floor((asOf−step−from)/step)+1)`, clamped at 0. I hand-checked it at `asOf = from+step−1` (0 slots), at `from+step` (1 slot), and with negative numerators.
  - Float `floor` is safe at these magnitudes. The quotient is at most about 3e6, and its gap from the next integer is at least `1/step`, which is far above double rounding.
- **Outlier rule** (`validator.ts:150-197`):
  - TR is `(max(h, c_prev) − min(l, c_prev)) / c_prev`.
  - A bar is judged only when `k ≥ window + 1`, so the dummy ratio at index 0 is never inside a median window.
  - The median window is `ratios[k−window, k)`, which holds only bars before *t*.
  - An even count takes the mean of the two middle values, and the test is a strict `>`.
  - I recomputed every fixed case:
    - **spike:** 0.20 against a median of 0.01 is flagged; the next bar is accepted.
    - **level shift:** the ratio is 1.0, flagged; the next bar is 2/200 = 0.01, accepted.
    - **volatility:** bars 6 and 7 are flagged. At bar 8 the median is (0.01 + 0.4)/2 = 0.205, so it is accepted.
    - **pinned cases:** 2/100 against 2/98, gaps of 102 and 102.01 and of 98 and 97.99, 101.000001, and the even-window median of 0.02 against 0.0201.
  - All of them match the implementation.
- **Live and replay (D13):**
  - Verdicts depend only on `history ++ closed batch`.
  - The split property (criterion 21) and the cut-and-replace property (criterion 20) use independent oracles.
  - Nothing is reimplemented outside TypeScript.
  - The purity scan covers clock, environment and randomness.
- **Missing data:**
  - Quarantined, outlier and conflicting-duplicate slots count as missing.
  - Nothing is filled.
  - The ranges are maximal.
  - The metrics gap pins `[1790814900000, 1790817900000)`, which I recomputed with `Date.UTC`.
- **Freshness:**
  - `ageMs = asOf − close − 1`.
  - `≤ maxAgeMs` is FRESH.
  - `close ≥ asOf` is `clock_skew`.
  - Only FRESH unblocks entries.
- **Fixtures:**
  - They are hand-written: the CSV with µs times, the REST file with ms times, and the metrics list.
  - Each bar is OHLC-consistent and taker-consistent, and I checked them line by line. The anchor and close values match the spec.
  - Every expected value is a literal or comes from an independent oracle (`expectedSlots`, `Date.UTC`), not from the code under test.
- **Determinism:**
  - Output is sorted by open time, and `quarantined` is sorted by input index.
  - Decimal uses a clone with fixed precision 20 and rounding mode 4 (`ROUND_HALF_UP`).
  - The same input gives the same output.
- **Not applicable:** this job has no fill model, EV, indicators (ATR, RSI, ADX), test-split use or survivorship.

### Non-blocking: hand-offs for S1b, where the thresholds are chosen

1. **A zero median makes the outlier rule cascade** (`validator.ts:192-194`).
   - After a run of flat bars, where `o = h = l = c` equals the previous close (zero-trade bars or a trading halt), the median ratio is 0. Then `ratio > multiple × 0` flags every normal bar until at least half the window holds non-zero ratios.
   - Probe result: 10 flat 15m bars, then 10 normal bars, with `window` 8 and `multiple` 10. Slots 10 to 13 were quarantined as `outlier` and reported as `missing [10, 14)`.
   - With a production window of about 96 on 15m, one halt of 12h or more would mark about 12h of real bars as outliers.
   - This follows the spec's formula exactly, and it fails safe: the slots go missing, so entries are blocked and exits still read `quarantined[].candle`. That is why it does not block here.
   - It does contradict the spec's statement that the rule "never cascades".
   - **Fix:** when S1b picks the production window and multiple (from train-split research), add a floor on the reference, such as a minimum ratio or a minimum tick relative to price, or a rule for a zero median. Add a test with flat bars followed by normal bars.
2. **The true range is measured across a gap** (`validator.ts:179-184`).
   - The predecessor is the previous bar in `S`, even across missing slots. After a gap of several hours, a normal drift reads as a wide true range and can be flagged.
   - The builder recorded this, and it also fails safe.
   - S1b should decide whether a bar after a gap is better left unjudged than measured against a stale close.
3. **Off-grid times are dropped without a trace in `missingRanges`** (`validator.ts:360-366`).
   - A timestamp off the grid is ignored, and its slot is reported missing. That is safe, but nothing records the row.
   - When S1b adds the metrics row schema, it should quarantine off-grid `create_time` rows itself instead of relying on `missingRanges` to absorb them.
4. **Closed by the clock is not closed by the exchange** (hand-off to S1c and S1d).
   - A bar counts as closed as soon as `asOfMs > closeTimeMs`. A REST poll right after the boundary can still return a bar that is not final.
   - The S1c and S1d adapters should use the WebSocket `x` flag, or a short settle delay, before they treat a bar as closed. They should also not put a provisional copy and a final copy of one slot in the same batch: that becomes `duplicate_conflict`, and the slot goes missing.
5. **Precision at the threshold.**
   - The ratio, median and multiple are rounded to 20 significant digits. A ratio within about 1e-20 relative of the threshold could therefore round either way.
   - This is deterministic and does not matter at any realistic multiple. The builder recorded it.
