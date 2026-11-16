VERDICT: PASS

## Scope

Round 3 (`1939223` on `78d582a`) changes four files. In `src/market-data/validator.ts` only the `outlierVerdicts` doc comment changes (lines 191-196). It also adds two tests to `validator.spec.ts` and changes text in `progress.md` and `tests.json`. I re-read the full `main...HEAD` diff as well. Rounds 1 and 2 passed risk review, and their code is unchanged this round.

Nothing in the diff touches the risk engine, an order path, the entry gate, the 48-entry counter, the kill switch, stops, limits, the DecisionProvider or Claude, so those checklist items do not apply. `git diff main...HEAD --stat` shows no change under `factory/`, `.claude/`, `CLAUDE.md`, `src/db/`, `src/config/` or `docker-compose.yml`. `package.json` and the lockfile are unchanged this round.

Checked and found sound:

- **No logic change.** The only change under `src/` is the comment. The verdict code (`validator.ts:211-223`), the closed check (`:313`), the expected slots (`:338-352`) and `freshness`/`freshnessBlocksEntries` (`:422-446`) are the same as in round 2.
- **The overclaim is corrected.** The `progress.md` Settlements "Choices" bullet and the doc comment no longer say a flat run never flags the bars after it. They now give the real behaviour: no bar is flagged *because* the median is zero, and zero ratios left in the window bias the median low for up to `window` bars. They also say this fails safe: the slot goes missing and entries are blocked. That direction is correct, because a quarantined slot is in `missing`, and S3/S7a treat `missing` as UNKNOWN.
- **The new pinned probe** (`validator.spec.ts`, "zero ratios left in the window bias the median low (round 3)"). I checked it by hand:
  - At k=14 the window is ratios 6..13, which is four flat bars at 0 and four tight bars at 0.001. The median is 0.0005 and the threshold 0.005, so the calm bar's 0.01 is flagged.
  - At k=15 the window is 7..14. The median is 0.001 and the threshold 0.01, and 0.01 is not greater than 0.01, so the bar is accepted. Exactly one outlier is the right answer.
  - The control matches the threshold exactly and is not flagged, which also pins the strict `>`.
  - `asOfMs = slot(n)` closes every bar.
  - The expected values come from an integer oracle that is independent of the code under test. The placeholder ratio at index 0 never enters the window.
  - I ran the market-data specs in the worktree: 4 files, 278 tests, all pass.
- **The round-2 risk notes are recorded:**
  - Note 1 is now an S3/S7a hand-off. Bars in `unjudged` have not passed the outlier check, and the fail-safe default is that they do not count as verified entry input.
  - Note 3 is now an S1c/S1d hand-off. A flat feed still reads FRESH, so a long flat run on a liquid pair is a data-health signal.
  - Note 2 (the near-zero-median bounded cascade) is covered by the corrected "Choices" wording. The S1b note that `maxRangeMultiple ≥ 1` is needed for the bound is also recorded.
- **Money, fail-safe defaults and exits** are unchanged from rounds 1 and 2:
  - Prices and volumes are `Decimal` from string. A JS `number` in a money field is rejected.
  - No exception is caught or swallowed. Argument errors throw, and row content never does.
  - `freshnessBlocksEntries` is false only for FRESH.
  - Outlier candles stay readable in `quarantined[].candle` for the S10b exit side.
- **Tests.** Nothing was deleted, skipped, renamed or loosened. Two tests were added.

## Findings

None blocking.

Non-blocking, carried forward for later jobs, not for this one:

1. The S3/S7a "unjudged bars are not verified input" default exists only as a `progress.md` hand-off. Today nothing consumes `candles`, so nothing can trade on an unjudged bar yet. When S3/S7a land, the risk review there should require a dedicated test showing that a zero-median `unjudged` bar cannot be the only support for an entry signal.
