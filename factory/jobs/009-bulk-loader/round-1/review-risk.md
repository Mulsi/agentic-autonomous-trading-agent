VERDICT: PASS

## Scope

This job is a market-data ingestion path: a separate `backfill` command, paper mode, no orders. It has no order path, no risk engine, no entry gate, no 48-entry counter, no exits, no kill switch and no Claude call, and it does not touch any of those. The checks that apply are data integrity before the strategy engine reads `candles`, money as `Decimal`, no look-ahead, fail-loud errors, no blind retry, and idempotent writes. Nothing found blocks.

Checked and found sound:

- **Look-ahead.** `planFiles` (`src/market-data/bulk-loader.ts:171-190`) refuses any period with `range.toMs > asOfMs` before any GET, and the clock is read once. Pinned at `test/unit/market-data/bulk-loader.spec.ts:366-418`, including the exact boundary at 1 ms before the end and at the end.
- **Verify before parse.** The SHA-256 comparison (`bulk-loader.ts:390-393`) comes before `readSingleEntry` and `splitBulkCsv`. A mismatch, a CHECKSUM 404, a bad or unavailable CHECKSUM, or an oversize zip each produces no sink call. Pinned with spies (`bulk-loader.spec.ts:187-330`).
- **No overwrite.** Candles are written with `ON CONFLICT DO NOTHING`. A slot that is already stored is compared field by field with `Decimal.eq` (`src/market-data/candle-store.ts:48-65, 169-207`). A difference quarantines the incoming line, and the code has no `.update(`. Pinned with an 18-significant-digit difference (`test/db/candle-store.db-spec.ts:347-389`).
- **Atomicity.** Each file is one transaction, and any throw rolls back candles, quarantine rows and the asset row together (`candle-store.db-spec.ts:447-479`). If a commit times out, it is unknown whether the file was stored. A re-run settles that, because it is idempotent and compares against what is stored.
- **Concurrency.** Two overlapping runs are safe under READ COMMITTED. `ON CONFLICT DO NOTHING` waits for the other transaction to commit, and the follow-up `SELECT` sees the committed row. A row that was neither inserted nor stored throws (`candle-store.ts:195-198`) and gives `store_error`.
- **Money.** The eight price and volume fields stay `Decimal` from parse to `toFixed()` into unbounded `numeric`, with no rounding. `maxRangeMultiple` is a ratio, not money, and the validator wraps it in `Decimal`.
- **No retry and fail-loud errors.** No code path retries. Every transport, HTTP, checksum, archive, CSV and store failure becomes a non-`loaded` status, and any one of them makes the run exit 1. Errors from the validator, the sink mapping or the HTTP guard reject the run and exit 1 with the error class logged. The write path refuses an identity that is not `VERIFIED` before any request is made.
- **Fail-safe outlier state.** Unjudged bars are stored with `outlier_checked = false`, and a later run never flips them to `true` (`candle-store.db-spec.ts:391-445`).

## Findings

No blocking findings. These notes are non-blocking and are recorded for the orchestrator and the downstream jobs (S3, S7a).

1. **A stored candle can coexist with a later `outlier` or `stored_conflict` quarantine row for the same slot, and the candle row does not record which outlier settings judged it.** See `src/market-data/candle-store.ts:84-93` and `bulk-loader.ts:230`.
   - Scenario A. The human backfills with a permissive `--outlier-multiple`, for example 1000, as in the criterion-34 command but without `--dry-run`. A spike bar is stored with `outlier_checked = true`. A later run with the production multiple flags it: an `outlier` quarantine row is added, but the candle stays in `candles` with `outlier_checked = true`.
   - Scenario B. A strict run leaves a slot missing, which fails safe. A later permissive run fills that slot with `outlier_checked = true`, while the old `outlier` quarantine row stays.
   - Scenario C. Binance republishes a corrected file. The stored candle keeps the old values, and only `market_data_quarantine` shows the dispute.
   - In all three cases, a reader that only selects from `candles` uses a disputed bar as verified data.
   - The spec chose this behaviour (Open decisions 3, and "never overwrite"), and nothing reads `candles` yet, so this does not block.
   - Fix (a hand-off, not code now): add a `progress.md` hand-off to S3 and S7a. A candle with `outlier_checked = false`, or with any `market_data_quarantine` row for the same symbol, timeframe and `open_time_ms`, is unverified input and makes the feature UNKNOWN, which blocks entries. Optionally, a later migration could store the outlier window and multiple on each candle row, so a verdict can be traced to its settings.
2. **The quarantine key drops a second, different raw line without telling anyone.** The primary key is `(source_file, row_index, reason)`, and inserts use `ON CONFLICT DO NOTHING` (`candle-store.ts:209-230`, `0004_market_data.sql`).
   - Scenario: a third version of a republished file conflicts at the same row index. Its line is not stored, but `storedConflicts` still counts it.
   - This loses provenance only. No bad data reaches `candles`.
   - Fix (optional): return the number of quarantine rows actually inserted and report it next to `storedConflicts`, or add a hash of `raw` to the key.
3. **No test pins "no retry" on the zip request.**
   - The CHECKSUM failure cases assert `http.urls()` equals `[checksumUrl]` (`bulk-loader.spec.ts:252-266`).
   - The zip failure cases (`bulk-loader.spec.ts:283-316`) do not assert that the zip URL was requested exactly once.
   - The code clearly does not retry, so this is test hardening.
   - Fix: add a zip `timeout` or `network` case that asserts `http.urls()` equals `[checksumUrl, zipUrl]`.
4. **`readSingleEntry` catches every error** (`src/market-data/zip-entry.ts:303-306`). An unforeseen error, programmer bugs included, becomes `{ ok: false, reason: 'malformed' }`. It still fails closed: the file is rejected and the run exits 1. So this is acceptable, and the spec says the reader "never throws on archive content". Noted only so that `malformed` in a real run is treated as a possible reader bug, not just a bad archive.
