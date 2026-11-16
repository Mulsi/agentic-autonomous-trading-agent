VERDICT: CHANGES

## Findings

I reviewed the full diff `main...HEAD` (`3ca6158` + `78d582a`), with most attention on round 2. The round-1 quant checks (D12 epoch reading, alignment, Decimal parsing, closed/open boundary, expected slots, the TR ratio, freshness, fixtures, determinism) still hold, because round 2 did not touch that code. The six market-data and decimal spec files pass locally (305 tests). I checked the round-2 math by hand and ran a scratch probe from the scratchpad, which wrote nothing to the repo.

### Blocking

1. **`progress.md:121` makes a guarantee the rule does not keep: "so a flat run never flags the bars after it".**
   - The human note asked round 2 to remove the "never cascades" overclaim and say what the rule actually guarantees. This sentence is a new overclaim of the same kind.
   - What is true: a bar is never flagged *because the median is zero* (`validator.ts:213-215`). What is not true: that bars after a flat run are never flagged. Zero ratios stay in the window after the median turns non-zero. That pulls the median down to a low order statistic of the real ratios: for an even window, `(0 + smallest non-zero)/2`. So for up to `window` bars after the run, a bar is judged against a threshold that is too low.
   - Probe (window 8, multiple 10, 15m, price 100):
     - 10 flat bars, then 4 tight bars (range 0.1, ratio 0.001), then normal bars (range 1, ratio 0.01). Slot 14 is quarantined as `outlier`. At k=14 the window is ratios 6..13 = `[0,0,0,0,0.001,0.001,0.001,0.001]`, so the median is 0.0005 and the threshold is 0.005. 0.01 > 0.005.
     - The same bars with the flat run replaced by tight bars: nothing is flagged. The median is 0.001, the threshold is 0.01, and 0.01 is not > 0.01.
     - This shape is realistic after a halt: thin first bars, then normal ones.
   - This fails safe, because the slot goes missing and entries are blocked. The code matches the spec and the human note, so I am not asking for a code change. But S1b will choose production thresholds from this settlement, so the settlement must be accurate.
   - **Fix:** replace "so a flat run never flags the bars after it" with something like: "so no bar is flagged because the median is zero. Zero ratios stay in the window afterwards and bias the median low, so for up to `window` bars after a flat run, a bar can be flagged at a lower effective threshold (for an even window, as low as half the smallest real ratio in the window)." Optionally pin probe A above as a test, so the behaviour is documented. The other round-2 wording is accurate as written: the `validator.ts:183-193` doc comment, the Current state bullets at `progress.md:66-67`, and `build.md`.

### Checked and correct

- **Zero-median branch** (`validator.ts:210-215`):
  - Ratios are always ≥ 0, since `max(h, c_p) − min(l, c_p) ≥ h − l ≥ 0`.
  - With `z` zeros in a window of `w`, the median is zero exactly when `z ≥ floor(w/2) + 1`, for odd and even `w` alike. The property's oracle (`validator.property.spec.ts`, `zeros >= Math.floor(window / 2) + 1`) is independent of the code and matches this.
  - The dummy ratio at index 0 never enters a window, because `k ≥ window + 1` means `k − window ≥ 1`. The oracle correctly counts zeros only for `j ≥ 1`.
  - A real non-zero ratio cannot round to zero at precision 20.
  - The rule stays causal (`ratios[k−window, k)`) and stays in `Decimal`, with no new threshold. Live/replay agreement (criterion 21) still holds, because the verdict is still a pure function of `history ++ closed batch`.
- **Pinned round-2 cases** (`validator.spec.ts`), recomputed by hand with `calm` = ratio 0.01:
  - 10 flat bars, then 10 calm, window 8, multiple 10: at k=13 the window holds 5 zeros, so the median is 0 and the bar is unjudged. At k=14 there are 4 zeros, the median is 0.005, the threshold is 0.05, and the bar is accepted. `unjudged = 0..13` is correct.
  - A spike at 10 (ratio 0.2) is unjudged. At k=14 the median is 0.005, so calm is accepted.
  - A spike at 16: the window 8..15 has 2 zeros and 6 × 0.01, so the median is 0.01, the threshold is 0.1, and 0.2 is flagged. Slot 17's window has median 0.01, so it is accepted.
- **Range-change bound, `floor(window/2) + 1`, for `multiple ≥ 1`:**
  - Once `j ≥ floor(w/2) + 1` copies of a constant new ratio `b` are in the window, the median is exactly `b` whatever the old values are, and `b > m·b` is false for `m ≥ 1`.
  - So only the bars with `j = 0..floor(w/2)` can be flagged, all at the start of the new range. The property builds bars with `open = close = 10000`, so every ratio is exactly `2·half/10000`: an independent oracle. `floor(96/2) + 1 = 49` bars × 15m ≈ 12h matches `progress.md`.
- **Fixtures and determinism:** no fixture changed this round. The new tests use literal or independently computed expectations, not output of the code under test.
- **Not applicable:** this job has no fill model, EV, indicators (ATR, RSI, ADX), split use or survivorship.

### Non-blocking

- The range-change guarantee holds for a constant new range. With uneven new ranges, later bars can still be flagged on their own merits. "Bars of the new range flagged because of the change" is the precise reading. The present wording is acceptable.
