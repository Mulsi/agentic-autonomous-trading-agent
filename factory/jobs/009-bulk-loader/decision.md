ESCALATE

## Why

The work itself looks sound. The gate passed (`pnpm install --frozen-lockfile`, `test`, `lint`, `build`, no test deleted or skipped, no tripwires). All four round-1 reviews PASS with no blocking findings. The builder pasted `pnpm test:db` (93 passed) and `pnpm test:e2e` (41 passed) into `build.md`. The diff stays in scope: nothing changes under `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, `docker-compose.yml` or `.env*`. `validator.ts`, `normalizer.ts` and the lockfile are unchanged, and no dependency was added. No risk limit, strategy parameter, entry gate, exit path or Claude path is touched.

APPROVE still fails, on four separate grounds. Any one of them is enough to escalate:

1. **`gate.md` says `NEEDS_HUMAN: yes`.** The protected migration files changed: `0004_market_data.sql`, `meta/0004_snapshot.json` and `meta/_journal.json`.
2. **The spec has a `[human]` criterion that has not been met.** Criterion 34, the real-file check carried from S1a criterion 31, says "S1b does not merge without it". It has not run, and `real-file-check.md` does not exist.
3. **The spec has an Open decisions section.** It lists seven choices that "reviewers and the human should confirm", plus a backlog item that only the orchestrator or the human can add.
4. **There are deviations from the literal spec that a human should accept:**
   - Chained `history` is the accumulated `checked`, trimmed to `max(window + 1, last length)`. The spec says "the previous file's `checked`".
   - The sink method is `storeFile`, not `writeFile`.
   - Money is stored as `Decimal.toFixed()`, which drops the source's trailing zeros.
   - The summary has an extra `detail` key.

   The quant review proved the history change keeps chained and batch runs equal (D13), and the code review accepted it but said "the human should confirm".

## What a human should check

1. **Approve or reject migration `0004_market_data`.**
   - It creates `assets`, `candles` and `market_data_quarantine`, with a foreign key from `candles` to `assets` (`ON DELETE/UPDATE no action`).
   - It adds CHECK lists for `timeframe` and `reason`.
   - Every server-filled time is `timestamp(3) with time zone`.
   - There are no grants. `research_reader` reads the new tables through the 0003 default privileges.
   - File: `.worktrees/009-bulk-loader/local-trading-agent-backend/src/db/migrations/0004_market_data.sql`.
2. **Approve the two downloads for criterion 34, then have the orchestrator run the spec's exact `env -i … node dist/backfill.js --dry-run …` command.** The downloads are the `.CHECKSUM` and `.zip` of `BTCUSDT-15m-2026-10-01` from `data.binance.vision`.
   - Check every value in the criterion 34 table.
   - Expect the extra `detail: null` key.
   - Record the `header` value.
   - The builder lists the likely real-file mismatches: a CRLF CHECKSUM line, a `*name` binary-mode CHECKSUM line, a BOM, or the DOS directory bit set in the zip's attributes. Any one of these sends the job back to the builder with a new fixture.
   - Do not merge until `real-file-check.md` exists and matches.
3. **Confirm the Open decisions:**
   - klines only
   - `assets` arriving now
   - the quarantine table as an append-only incident log
   - a bar after a gap judged against the last checked close
   - archives kept in memory only
   - the zip reader written in-repo over `node:zlib`
   - the write path requiring a `VERIFIED` identity
4. **Add the derivatives bulk-file backlog item** (funding, metrics, premium-index) before S2c. `factory/` is protected, so the builder did not add it.
5. **Accept or reject the deviations** in `build.md` › "Deviations", especially the accumulated-history rule (item 2). If you accept it, reword spec step 5 to match, as the quant review recommends.
6. **A real concern that is not yet handed on.** The risk review (finding 1) and the quant review (note 1) both point out a gap that `progress.md` does not record:
   - A stored candle can sit alongside a later `outlier` or `stored_conflict` quarantine row for the same slot.
   - A bar at a run boundary can be stored with `outlier_checked = false`.
   - A reader that selects only from `candles` would then use a disputed or unverified bar as clean data.
   - Nothing reads `candles` yet, so this is not a blocker today.
   - **What to add:** a hand-off to S3 and S7a in `progress.md`. It should say that a candle with `outlier_checked = false`, or with any quarantine row for the same symbol, timeframe and `open_time_ms`, is unverified and makes the feature UNKNOWN, which blocks entries.
   - **Why it matters now:** a write run with the criterion-34-style `--outlier-multiple 1000` would store spikes as `outlier_checked = true`. Do not run a non-dry backfill with that permissive multiple.
7. **Non-blocking notes from the reviews, for later:**
   - The quarantine key `(source_file, row_index, reason)` drops the new raw text if Binance republishes a file. The fix would be to add the archive `sha256`.
   - `context.close()` in `backfill.ts`'s `finally` can throw and lose the exit code.
   - No test pins "no retry" on the zip request.
