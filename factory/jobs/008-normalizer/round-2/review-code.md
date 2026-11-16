VERDICT: PASS

## Findings

No blocking items. I read the round-2 diff (`78d582a`) and `build.md`. In the worktree I ran `pnpm test` (33 files, 1023 tests) and `pnpm lint`, and both pass. I did not rerun `pnpm build` (build.md reports it passing).

Checked against the human note:
- Zero-median fix, `validator.ts` `outlierVerdicts`:
  - A zero reference median now gives `unjudged_zero_median`. The bar is accepted, listed in `unjudged`, and still goes through every other check.
  - The rule stays causal and in `Decimal`, and adds no threshold or default.
  - The two unjudged causes are named in the internal `Verdict` type and in the doc comments. `KlineBatch.unjudged` gets no reason field, which keeps the change inside the note.
- Tests:
  - The probe (10 flat bars, then 10 normal ones, window 8, multiple 10) accepts slots 10 to 13.
  - A spike right after a flat run is pinned as accepted and unjudged. build.md explains the choice: any floor would be an invented threshold.
  - A spike once the median is non-zero is still flagged.
  - A zero-median bar with `high < open` still fails the OHLC check.
  - The fast-check property for a flat run followed by normal bars is present. The bound property, at most `floor(window / 2) + 1` flagged bars after a lasting range change, is extra but supports the new wording.
  - build.md reports a mutation check: removing the `isZero` branch fails five tests. The existing pinned outlier cases are unchanged.
- Wording:
  - No "cascade" text remains in the worktree. The doc comment, `progress.md` and `tests.json` now state what the rule guarantees.
  - `spec.md` still says "never cascades". build.md notes this and says `factory/` was out of reach. That is acceptable.
- Hand-offs in `progress.md` match the note: the S1b, S1c/S1d and S10b items are all present and sit under the owning jobs.
- No other source change and no scope creep.

Non-blocking notes:
- The `floor(window / 2) + 1` bound holds only for `maxRangeMultiple >= 1`. The comment and the property both state that condition. S1b must keep the production multiple at 1 or more, or the wording needs revisiting.
- A genuine spike after a flat run is accepted, only visible through `unjudged`. This is the documented choice. S1b and S3 should treat `unjudged` as lower confidence.
- Round-1 note, still unfixed and non-blocking: the `as Parsed` cast at `validator.ts` around line 299.
