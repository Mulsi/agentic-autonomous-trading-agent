# Human note for round 2 (008-normalizer)

The five open decisions in `spec.md` stand as built. Fix these three things in this job, then update `build.md` with a "Round 2" section.

1. **Zero-median outlier cascade** (`src/market-data/validator.ts:192-194`; quant hand-off 1, risk note 1). After a run of zero-range bars (a halt or zero-trade period), the reference median is 0 and every normal bar is flagged until half the window holds real movement. With a 15m window of about 96 bars, one halt of 12 hours or more hides about 12 hours of real bars.
   - When the reference median is zero, the bar cannot be judged. Do not flag it as an outlier. It stays subject to every other check (OHLC sanity, duplicates, alignment and so on). Name the case in the code and in the result, if the result already reports why a bar was or was not judged.
   - Keep the rule causal and in `Decimal`, with no new default thresholds.
   - Tests: a pinned case using the quant reviewer's probe shape (10 flat bars, then 10 normal ones, window 8, multiple 10), where slots 10 to 13 are now accepted. A genuine spike right after a flat run: decide and pin what happens, and explain the choice in `build.md`. A fast-check property that a flat run followed by normal bars never flags a normal bar for the zero-median reason. Keep every existing pinned outlier case passing.
2. **Correct the wording.** Remove or correct the "never cascades" claim wherever it appears (spec-facing comments, `progress.md`, `tests.json`). State what the rule now guarantees.
3. **Record the reviewers' hand-offs in `progress.md`**, under the jobs that own them:
   - S1b: quarantine storage keeps the raw row as data (parameterized inserts, never formatted into a log line, never given to Claude as instructions); production outlier window and multiple; whether a bar measured across a gap of missing slots is judged at all (quant 2); metrics rows with off-grid times are quarantined instead of silently dropped by `missingRanges` (quant 3).
   - S1c and S1d: cap payload and field length where data comes in (security 1); pass only the previous batch's `checked` output as `history` (security 3); a bar counts as closed only by the exchange's signal (the WebSocket `x` flag, or exchange server time with a short delay), not by the local clock alone, and a provisional and a final copy of one bar never land in the same batch (risk 2, quant 4).
   - S10b: emergency exits read outlier-flagged candles from the quarantine record, so a real crash bar is never hidden.

Do not change anything else. Run `pnpm test`, `pnpm lint` and `pnpm build`, and paste the results into `build.md`. No Docker and no downloads.
