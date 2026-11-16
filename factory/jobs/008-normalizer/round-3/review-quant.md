VERDICT: PASS

## Findings

No blocking findings. I reviewed the full diff `main...HEAD` (`3ca6158`, `78d582a`, `1939223`) and focused on round 3. Round 3 changes one doc comment in `src/market-data/validator.ts` (no logic), adds two tests to `validator.spec.ts`, and edits `progress.md` and `tests.json`. The round-1 and round-2 quant checks therefore still hold: D12 epoch reading, alignment, Decimal parsing, the closed/open boundary, expected slots, the TR ratio, the zero-median branch, the `floor(window/2) + 1` bound, freshness, fixtures and determinism. The six market-data and decimal spec files pass locally (307 tests, up from 305).

### Round-2 blocking item: resolved

- **The flat-run overclaim** (`progress.md:121`). "So a flat run never flags the bars after it" is gone. The bullet now says:
  - no bar is flagged because the median is zero
  - zero ratios stay in the window and bias the median low for up to `window` bars, as low as half the smallest real ratio for an even window
  - a bar can still be flagged in that span, and that fails safe

  I checked each part:
  - **"Up to `window` bars".** The last zero ratio, at index `z`, stays in the windows of bars `z+1 .. z+window` and leaves at `z+window+1`.
  - **"As low as half the smallest real ratio" (even `w`).** A non-zero median needs at most `w/2` zeros. With exactly `w/2` zeros, the median is `(0 + smallest non-zero)/2`, which is the minimum.

  Both claims are correct. The `outlierVerdicts` doc comment (`validator.ts:191-196`) says the same thing. I grepped the other places that could still overclaim and found them accurate:
  - `progress.md:66`, "a bar with a zero median is never flagged"
  - the `progress.md:67` guarantee bullet
  - both `tests.json` `covers` texts
  - the test titles

### The pinned probe, recomputed by hand (`validator.spec.ts`, "zero ratios left in the window bias the median low (round 3)")

Inputs: price 100, window 8, multiple 10. Ratios are in units of 1e-4: flat = 0, tight (100.05/99.95) = 10, calm (100.5/99.5) = 100. Every close is 100, so each ratio depends only on the bar's kind.

- **10 flat, 4 tight, 6 calm:**
  - k=9 to 13: the median is 0 (at k=13 the window holds 5 zeros), so these bars are unjudged.
  - k=14: window 6..13 is `[0×4, 10×4]`, so the median is 5 and the threshold 50. The ratio 100 > 50, so the bar is an **outlier**.
  - k=15: the flagged 100 stays in the window, which is `[0×3, 10×4, 100]`. The median is 10, the threshold 100, and 100 is not > 100, so the bar is accepted.
  - k=16 and 17 have a median of 10, k=18 a median of 55 and k=19 a median of 100. All are accepted.
  - So only slot 14 is quarantined, and `missing = [slot 14, slot 15)`. This matches the assertions.
- **Control, tight bars in place of the flat run:**
  - k=9 to 14 have a median of 10, so the threshold is 100. Tight bars (10) are accepted. At k=14, 100 is not > 100.
  - k=15 to 17 have a median of 10, k=18 a median of 55 and k=19 a median of 100. Nothing is flagged.
  - The k=14 boundary is exact in `Decimal`: 1/100 against 10 × (0.001 + 0.001)/2 = 0.01, so `gt` is false. The control therefore also pins the strict `>`.
- **The oracle is independent.** `reference()` sorts integer ratios chosen by bar kind and averages indices 3 and 4. It takes nothing from the code under test. The literal expectations `[5, 50]` and `[10, 100]` match my numbers.

### Hand-offs added to `progress.md`

These are correct and need no math change:
- **S1b:** the multiple must be ≥ 1 for the bound to hold.
- **S3/S7a:** `unjudged` bars are not verified input by default.
- **S1c/S1d:** a flat feed still reads FRESH.

### Not applicable

This job has no fill model, EV, indicators (ATR, RSI, ADX), split use or survivorship.

### Non-blocking

- `reference()` in the round-3 test hard-codes window 8: `slice(k - 8, k)` and middle indices 3 and 4. That is fine for a pinned case, but the helper must change if someone reuses it with another window.
