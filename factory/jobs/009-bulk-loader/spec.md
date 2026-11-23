# S1b Bulk history loader

## Goal

Build the first job that stores market data. It downloads Binance **spot kline** archives from `data.binance.vision`, checks each archive against its published CHECKSUM before reading it, runs the S1a normalizer and validator over the rows, and writes the accepted candles and the quarantined rows to Postgres. Writes are idempotent.

What it must do:

1. **Download safely.** Only GET requests, only to the one bulk-data origin, with a byte cap, a timeout and no redirects. Archives stay in process memory: they are never written to disk, and the CSV inside is never extracted to a path.
2. **Verify, then parse.** Fetch the `.CHECKSUM` file, fetch the `.zip`, compare SHA-256 values, and only then open the archive. A mismatch rejects the file before a single byte is parsed.
3. **Read the archive defensively.** Accept exactly one entry with the expected name, a bounded size, a known compression method and a matching CRC-32. Reject anything else.
4. **Reuse S1a (D13).** Rows go through `validateKlines` unchanged. The loader passes each file's `checked` output as the next file's `history`.
5. **Store with no silent loss.** Accepted candles go to `candles`. Quarantined rows go to `market_data_quarantine` with their raw line kept as data. A row that conflicts with an already stored candle is quarantined, and the stored row is never overwritten. A second run over the same files changes nothing.
6. **Carry S1a criterion 31.** A real-file check on the BTCUSDT 15m spot file for 2026-10-01 runs after a human approves the download. It is required for merge.

## Plan references

- Backlog S1b (`factory/backlog.md` line 18), including the carried S1a criterion 31, the "multiple at least 1" note, and the `timestamptz(3)` rule for server-filled times (S0f review).
- `factory/jobs/008-normalizer/human-approval.md`: criterion 31 is deferred to S1b and is not waived.
- `progress.md` › Settlements › Market data › Hand-offs › S1b. Each item is mapped to a criterion or an out-of-scope line under "Hand-offs from S1a" below.
- SLICE_1_PLAN:
  - **§5 S1**: the bulk history loader from `data.binance.vision` (spot klines 15m, 1h, 4h, 1d; USDⓈ-M `fundingRate`; `metrics`; `premiumIndexKlines`) with CHECKSUM verification. Validation quarantines invalid data and never uses it silently, and missing data is explicit. Storage keeps `quote_volume`, `taker_buy_base_volume` and `taker_buy_quote_volume`. The S1 "Done when" (history from 2022-01, plus a 24h live run) applies when S1d merges.
  - **§7**: the master §4 schema for `assets` and `candles`, with `quote_volume`, `taker_buy_base_volume`, `taker_buy_quote_volume` and `is_closed` added to `candles`. No quarantine table is listed.
  - **§4**: `market-data/bulk-loader.ts`; `scripts/backfill.ts`; each `src/` folder is a Nest module; calculation code is pure.
  - **D2**: decimal.js for money, `numeric` read as a string, zod for external payloads, built-in `fetch`.
  - **D3**: the universe is a config list. §11.5 is still open.
  - **D11**: fail loudly, with no swallowed errors.
  - **D12**: UTC, and µs times in bulk spot files.
  - **D13**: one TypeScript implementation.
- Master plan:
  - Part I §3 Rule 9: UNKNOWN means reconcile, verify, resume, and never blindly retry.
  - Part I §3 Rule 11: external content is data.
  - Part II §4: the `assets` and `candles` tables.
  - Part II §13 (end): do not invent production numeric limits.
  - Part II §24 Phase 3 (migrations with tests), Phase 5 (read-only public data), Phase 7 ("Invalid data must never silently enter the strategy engine").
- `progress.md` settlements:
  - Database: tables arrive with the job that first uses them; the column conventions and the schema scan; `_ms` names; `timestamptz(3)` when the server fills the time.
  - D1: `scripts/` and `prompts/` stay in the app folder.
  - Dependencies: D9 test.
  - Hand-offs from S0e: `blocksEntries` and identity.

### Plan versus repo

1. **Entry point.** §4 names `scripts/backfill.ts`, but `pnpm build` compiles only `src/`, and there is no TypeScript runner. Nest's decorators also rule out Node's type stripping. The entry is therefore `src/backfill.ts`, built to `dist/backfill.js`. The S11b `trader` CLI (nest-commander) can absorb it later. This follows §4's intent: a backfill command that is separate from `trader run`.
2. **The S1a endpoint scan.** `test/unit/market-data/purity.spec.ts` criterion 26 bans `https://` and `binance.vision` in every file under `src/market-data/`, but §4 puts the bulk loader there. The scan is narrowed to the smallest exception:
   - exactly one file, `src/market-data/binance-vision.ts`, may hold exactly one origin string, `https://data.binance.vision`
   - every other needle, and every other file in that folder, in `test/unit/market-data/` and in `test/fixtures/market-data/`, stays banned
3. **Recorded-state tests that this job must update.** These tests record "only the marker table exists, and the app writes nothing". They change to the new exact state. They are not loosened:
   - `test/unit/db/drizzle.spec.ts`:
     - "declares exactly one table" becomes an exact list of four tables.
     - "creates only the marker table" becomes an exact list.
     - "no migration contains DELETE/UPDATE" ignores only the referential clauses `ON DELETE NO ACTION` and `ON UPDATE NO ACTION` that drizzle-kit writes for a foreign key.
     - "no non-spec source … contains `.insert(`" allows exactly `src/market-data/candle-store.ts`.
   - `test/unit/db/schema-scan.spec.ts`: "scans every table" becomes an exact list.
   - `test/db/migrate.db-spec.ts`: `MARKER_OBJECTS` becomes the exact new object inventory.
   - `test/unit/tooling/repo-files.spec.ts`: Next names S1c.

   Criterion 27 lists every allowed change. No other existing assertion may change.
4. **Master §4 `candles.timestamp`** becomes `open_time_ms`, following the S0 `_ms` convention. `close_time_ms` and `outlier_checked` are added. The reasons are in Scope.
5. **Derivatives bulk files.** §5 S1 lists `fundingRate`, `metrics` and `premiumIndexKlines` under the bulk loader. This job loads spot klines only. The reason is under Scope › Out. They need a new backlog item before S2c. `factory/` is protected, so the orchestrator or the human adds that item, not the builder (see Open decisions).

## Scope

### In

**Origin, names and CHECKSUM: `src/market-data/binance-vision.ts`** (pure: no I/O, clock or environment)

- `BINANCE_VISION_ORIGIN = 'https://data.binance.vision'`. This is the only URL in `src/`, apart from `src/config/`, which keeps its URL parsing.
- Inputs:
  - `symbol` matches `^[A-Z0-9]{1,20}USDT$` (spot USDT pairs, §2).
  - `interval` is a `KlineInterval` (`15m`, `1h`, `4h`, `1d`).
  - `period` is `daily` or `monthly`.
  - A daily date is `YYYY-MM-DD`, a monthly date is `YYYY-MM`, both read as UTC.
  - Anything else throws a `TypeError` or `RangeError` naming the argument, before any URL is built.
- `bulkFile(symbol, interval, period, date)` returns these fields:
  - `zipName`: `BTCUSDT-15m-2026-10-01.zip` for daily, `BTCUSDT-15m-2026-10.zip` for monthly.
  - `checksumName`: `zipName + '.CHECKSUM'`.
  - `csvName`: `BTCUSDT-15m-2026-10-01.csv` for daily.
  - `zipUrl` and `checksumUrl`: `${ORIGIN}/data/spot/{daily|monthly}/klines/{SYMBOL}/{interval}/{name}`, built by joining validated segments. Not by `new URL(`, which stays only in `src/config/secrets.ts`.
  - `range: { fromMs, toMs }`: the half-open UTC period, either one day or one calendar month.
- `filesFor(symbol, interval, period, from, to)` lists every period from `from` to `to`, inclusive, in ascending order. `from > to` is a `RangeError`.
- `parseChecksum(text, expectedZipName)` returns `{ ok: true, sha256 }` or `{ ok: false, reason }`.
  - The text must be one line, optionally ending in `\n`.
  - The line is `<64 lowercase hex><one or two spaces><name>`, and `<name>` must equal `expectedZipName` exactly.
  - Anything else fails, including uppercase hex, extra lines, another file's name, a path in the name, and an empty body.

**CSV: `src/market-data/bulk-csv.ts`** (pure)

- `splitBulkCsv(text, expectedSlots)` returns `{ ok: true, header, lines: { index, text, fields }[] }` or `{ ok: false, reason }`.
- Lines are split on `\n`. One empty final line, the trailing newline, is ignored. Every other line is a row, including an empty line in the middle of the file, which the validator then quarantines as `malformed_row`. `fields` is `text.split(',')`.
- **Header.** If the first line exactly equals the documented Binance kline header, `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore`, it is skipped and `header` is `true`. Any other first line is a data row. If it is not valid data, it is quarantined, never dropped.
- **File-level rejections.** Each of these rejects the whole file with its reason. Nothing from the file is stored.
  - `bad_encoding`: the bytes are not valid UTF-8 (`TextDecoder` with `fatal: true`).
  - `nul_byte`: the text contains a NUL byte.
  - `line_too_long`: a line is longer than `MAX_LINE_BYTES` (1024).
  - `too_many_rows`: the file has more than `2 × expectedSlots + 1` lines.

  These are structural faults in a file whose CHECKSUM already passed. Row content is still judged row by row by the validator.
- `timeUnits(lines)` counts `normalizeEpoch(fields[0]).unit` over the data rows and returns `{ us, ms, unreadable }`.

**Archive: `src/market-data/zip-entry.ts`** (`node:zlib` and `Buffer` only; no `node:fs`)

- `readSingleEntry(zip: Uint8Array, expectedCsvName, maxBytes)` returns `{ ok: true, bytes }` or `{ ok: false, reason }`. It never throws on archive content.
- It reads the end-of-central-directory record, then the central directory, then the local header.
- It rejects each of these:
  - a missing or duplicated end record
  - an entry count other than 1
  - a name that is not exactly `expectedCsvName`: one containing `/`, `\`, `..`, a leading `/`, a drive letter or NUL is never equal, so it is rejected by construction
  - a local header name that differs from the central one
  - a directory entry
  - the encryption flag (bit 0)
  - ZIP64 markers
  - a compression method other than 0 (stored) or 8 (deflate)
  - a declared uncompressed size above `maxBytes`
  - inflated output above `maxBytes` (`inflateRawSync` with `maxOutputLength`)
  - inflated length different from the declared size
  - a CRC-32 (`zlib.crc32`) different from the declared one
  - offsets or lengths that point outside the buffer
- The data-descriptor flag (bit 3) is allowed: sizes and the CRC come from the central directory.
- The entry is returned as bytes and never written anywhere, so no archive name ever becomes a path. Zip-slip has no path to escape through.

**HTTP: `src/shared/bounded-fetch.ts`**

- `boundedGet(url, { maxBytes, timeoutMs })` returns `{ ok: true, status, body }` or `{ ok: false, reason: 'timeout' | 'too_large' | 'redirect' | 'network' }`.
  - It is a GET through the built-in `fetch` with `redirect: 'error'` and `AbortSignal.timeout(timeoutMs)`.
  - A `Content-Length` above `maxBytes` is refused before the body is read.
  - The body is read as a stream with a running count, and the request is aborted as soon as the count passes `maxBytes`.
  - Non-2xx statuses are returned with an empty body. They never throw.
- This is the only file under `src/` that calls `fetch(`.
- The loader's `HttpGet` interface wraps it. The production implementation also refuses any URL that does not start with `${BINANCE_VISION_ORIGIN}/data/spot/`.

**Limits** (exported constants, each with a comment)

| Constant | Value |
|---|---|
| `MAX_CHECKSUM_BYTES` | 1 KiB |
| `MAX_ARCHIVE_BYTES` | 8 MiB |
| `MAX_CSV_BYTES` | 16 MiB |
| `MAX_LINE_BYTES` | 1024 |
| `REQUEST_TIMEOUT_MS` | 60 000 |

These are input-safety bounds sized well above the largest expected file: a monthly 15m file holds at most 2,976 rows of about 150 bytes. They are not trading or risk limits, so master Part II §13 does not apply to them.

**Loader pipeline: `src/market-data/bulk-loader.ts`**

- `loadKlines(request, deps)`:
  - `request`: `{ symbol, interval, period, from, to, asOfMs, outlier: { window, maxRangeMultiple }, dryRun }`
  - `deps`: `{ http: HttpGet, sink: CandleSink | null }`
- `asOfMs` is the caller's clock. The CLI reads it once at start. Any period with `range.toMs > asOfMs` is refused with a `RangeError` before any request is made, so the loader never asks for a period that has not fully closed.
- Files are processed one at a time, in ascending order, with no concurrency and no automatic retry. For each file:
  1. GET the CHECKSUM, capped at `MAX_CHECKSUM_BYTES`, and parse it. A non-200 response, a transport failure or a parse failure gives `checksum_unavailable` (with `not_found` on a 404), and the zip is not requested.
  2. GET the zip, capped at `MAX_ARCHIVE_BYTES`. A failure gives `not_found` or `http_error`.
  3. Compute the SHA-256 of the zip bytes (`node:crypto`). If it differs from the CHECKSUM value, the result is `checksum_mismatch`: the archive is not opened, and nothing is parsed or written.
  4. `readSingleEntry`, then `splitBulkCsv`. A failure gives `archive_rejected` with its reason.
  5. `validateKlines(rows, { symbol, interval, range, asOfMs, outlier, history })`. `history` is the `checked` output of the last file in this run that reached step 5, or none for the first.
  6. Unless `dryRun`, `sink.writeFile(...)` stores the result in one transaction.
- Each quarantine record is mapped back to its CSV line by the identity of `raw`, the array the loader passed in. The stored raw value is that line's original text.
- A failed file never stops later files. The run's exit status reflects every failure.
- **Per-file summary** (a plain object with no raw content):
  - `file`, `status` (`loaded` or the failure reason), `checksum` (`verified` or the failure), `sha256`
  - `header`, `rows`, `accepted`, `open`, `quarantined` (count by reason), `missing` (ranges), `unjudged` (count), `duplicatesCollapsed`, `outOfOrder`
  - `timeUnits`, `firstOpenTimeMs`, `lastOpenTimeMs`, `lastCloseTimeMs`
  - `written` (`false` in a dry run), `inserted`, `alreadyStored`, `storedConflicts`
  - `outlier: { window, maxRangeMultiple, provisional: true }`

**Storage: `src/db/schema.ts`, one generated migration, and `src/market-data/candle-store.ts`**

Tables, following the S0 conventions. Choice columns use `text` plus a `CHECK`, so there is no `pgEnum`:

- **`assets`**, a subset of master §4:
  - `id`: `uuid`, primary key, default `gen_random_uuid()`
  - `exchange`, `market_type`, `symbol`, `base_asset`, `quote_asset`: `text not null`
  - `created_at`: `timestamp(3) with time zone`, default `now()`
  - `UNIQUE (exchange, market_type, symbol)`
  - The loader writes `('binance', 'spot', symbol, symbol without USDT, 'USDT')`, insert-if-absent.
  - Master columns `status`, `cmc_rank`, `sector` and `updated_at` are left out: S1c (exchangeInfo status) and W5 (CMC rank) bring them.
- **`candles`**, master §4 plus §7:
  - `asset_id`: `uuid not null`, references `assets(id)`
  - `timeframe`: `text`, checked in (`15m`, `1h`, `4h`, `1d`)
  - `open_time_ms` and `close_time_ms`: `bigint`, number mode
  - `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `taker_buy_base_volume`, `taker_buy_quote_volume`: `numeric`, string mode, with no precision, so exact strings survive
  - `trade_count`: `bigint`, bigint mode (`integer` stops at 2³¹ − 1)
  - `is_closed`: `boolean not null`. Bulk rows are always `true`.
  - `outlier_checked`: `boolean not null`. It is `false` for bars in the validator's `unjudged`, so S3 and S7a can still tell them apart after storage.
  - `source`: `text not null`, `'binance_vision'`
  - `ingested_at`: `timestamp(3) with time zone`, default `now()`
  - `PRIMARY KEY (asset_id, timeframe, open_time_ms)`
- **`market_data_quarantine`**:
  - `source` and `source_file`: `text not null`. `source_file` is the zip name.
  - `row_index`: `integer not null`, the 0-based line index in the CSV
  - `symbol` and `timeframe`: `text not null`
  - `reason`: `text not null`, checked in the exported list of every `QuarantineReason` plus `stored_conflict`
  - `open_time_ms`: `bigint`, number mode, nullable
  - `raw`: `text not null`, the original line
  - `quarantined_at`: `timestamp(3) with time zone`, default `now()`
  - `PRIMARY KEY (source_file, row_index, reason)`
- **Migration.** The schema change goes through `pnpm db:generate` into the next numbered migration under `src/db/migrations/`, with its snapshot and journal entry. It is never hand-written or pushed. It needs a human (gate `PROTECTED`). `research_reader` reads the new tables through the default privileges from migration 0003, and no new grant is added.
- **`CandleSink.writeFile(file, batch, lines)`** writes one file in one transaction:
  - Insert the asset if it is absent, then read its `id`.
  - Insert the accepted candles with `ON CONFLICT DO NOTHING`, in chunks that stay under Postgres's 65,535-parameter limit.
  - For each candle that was not inserted, read the stored row and compare the ten market fields: the times by `===`, the rest by `Decimal.eq`.
    - If they are equal, it counts as `alreadyStored`. Nothing is written, and `outlier_checked` is never changed.
    - If they differ, it counts as `storedConflicts`. The incoming line is quarantined as `stored_conflict`, and the stored row is never updated.
  - Insert the quarantine records with `ON CONFLICT DO NOTHING`.
  - Any error rolls the whole file back and gives `store_error`.
  - Writes go only through the Drizzle query builder, with parameters bound. There is no raw SQL, no `.update(` and no `.delete(`. The sink never names `databaseIdentity`.

**Wiring and CLI**

- `src/market-data/market-data.module.ts` provides the loader, the Drizzle sink (injecting `DATABASE`) and an `HTTP_GET` token.
- `src/backfill.module.ts` imports `ConfigModule`, `LoggerModule` (built exactly as `AppModule` builds it), `DbModule` and `MarketDataModule`.
- `AppModule` is unchanged.
- `src/market-data/backfill-args.ts` parses `argv` with zod. Every flag is required except `--dry-run`, and there are no defaults:

  | Flag | Rule |
  |---|---|
  | `--symbol` | one symbol |
  | `--interval` | one interval |
  | `--period` | `daily` or `monthly` |
  | `--from`, `--to` | inclusive, in the period's date format |
  | `--outlier-window` | integer ≥ 1 |
  | `--outlier-multiple` | decimal string, finite and ≥ 1 |
  | `--dry-run` | optional |

  A missing, unknown, repeated or invalid flag exits with code 2 and a usage message, and no request is made.
- `src/backfill.ts`:
  - **Dry run.** It builds no Nest context, reads no settings and opens no database connection. It runs `loadKlines` with the real HTTP and `sink: null`, and prints one JSON summary line per file to stdout. Nothing else goes to stdout.
  - **Write run.** It boots `BackfillModule` as a standalone context, with `BootConsoleLogger` and `printBootFailure` as `main.ts` uses them. It writes only when the boot's `IDENTITY` is `VERIFIED`. Otherwise it logs the identity line, writes nothing and exits 1. Each summary is logged as a structured line.
  - Exit codes: 0 when every file is `loaded`, 1 when any file failed or the write was refused, 2 on a usage error.
- `package.json` gets the script `"backfill": "node --env-file=../.env dist/backfill.js"`, which mirrors `start:prod` and is for the human's write runs. Factory agents never run it.
- **Logs and summaries never contain a raw line or a field value from a quarantined row.** They hold counts, reasons, times and file names only (Rule 11).

**Hand-offs from S1a** (`progress.md` › Settlements › Market data › S1b)

| Hand-off | Here |
|---|---|
| Quarantine storage and its migration (human); raw row kept as data, parameterized, never in a log line, never given to Claude | **In**: `market_data_quarantine`, criteria 17, 19, 21. There is no Claude in S1b, and no snapshot reads this table. |
| Production `outlier.window` and `outlier.maxRangeMultiple`, from config, marked provisional, fit on the train split | **In as required input with no value**: required CLI flags with no default, echoed as `provisional: true` (criteria 12, 14). **Out**: choosing the values. The plan gives no number, and fitting on the train split is research (S6 and `research/`). See Open decisions. |
| The multiple must be at least 1 | **In**: criterion 12. |
| Whether a bar after a gap of missing slots is judged at all | **In as a decision plus a pinned test**: keep the S1a rule (criterion 24). See Open decisions. |
| Metrics rows off the 5-minute grid are quarantined, not dropped by `missingRanges` | **Out**: it moves with the metrics loader (Out, below). It is recorded in the `progress.md` hand-offs. |
| Row schemas for premium-index klines, funding and metrics | **Out**: same item. Recorded in `progress.md`. |
| CSV header handling | **In**: criterion 6. |
| Backlog: every server-filled `timestamptz` is `(3)`, including raw-SQL `now()` | **In**: criterion 18. |

**Housekeeping**

- `progress.md`:
  - Current state › Market data: the loader, CHECKSUM, the limits, the archive rules, the tables, idempotency and the dry run.
  - Current state › Database: the new tables.
  - Settlements › Market data: the choices in Open decisions, and the hand-offs updated, with S1b's items marked done or moved.
  - The Done line `- [x] S1b …`.
  - Next names S1c.
- Root `.gitignore` gets `*.zip` and `*.CHECKSUM`. A file downloaded by hand into the tree is never committed, as defence in depth: the loader itself writes no file.
- `tests.json`: one entry per new spec, milestone `S1`. The `covers` text of each updated spec is corrected.

### Out

- **Funding, metrics and premium-index bulk files**, their row schemas, the metrics off-grid rule, and the `funding`, `open_interest` and `premium_index` tables. Nothing reads them before S2c (derivatives features), and the S0 settlement says a table arrives with the job that first uses it. Klines are what S2a, S2b and S3 need first. They become a new backlog item that must merge before S2c (see Open decisions).
- **Choosing production outlier values,** and `maxAgeMs`. The plan gives no number for either. `maxAgeMs` is a live-freshness value that S3 and S7a take from config. The loader judges closed history and never calls `freshness`.
- **Running the full 2022-01 backfill** for the universe. That is the S1 "Done when", which applies when S1d merges. It is the human's run with `pnpm backfill`. The universe list stays §11.5, and the loader takes one symbol per run.
- **Seeding `history` from the database.** Stored candles exclude outlier-flagged bars, so history seeded from the database would not equal `checked`, and live and replay would drift. The first `window + 1` bars of each run are left unjudged and stored with `outlier_checked = false`.
- **Keeping archives on disk, a download cache, retries, concurrency and resuming.** Re-running is idempotent. Never retry blindly (Rule 9).
- **A run or data-health table** (`system_events`), and the daily report (S11b). Missing ranges are reported in the run summary, and readers recompute them with `missingRanges` over stored open times.
- **REST and WebSocket** (S1c, S1d), the universe liquidity check (S1c), and any symbol that is not spot `…USDT`.
- **Changes to `normalizer.ts` or `validator.ts` logic.** This job adds only a test (criterion 24).
- **New dependencies.** Reading the archive uses `node:zlib`. No zip, HTTP or CSV package is added.
- **Protected and job-owned files:** `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans, `docker-compose.yml` and `.env*`. `src/db/migrations/` changes only by the one generated migration.

## Acceptance criteria

The suites are `unit` (`pnpm test`, which the gate runs: no network, database or Docker), `db` (`pnpm test:db` after `make db-up`, throwaway `trader_test_*` databases, run by the builder with the output pasted into `build.md`, because the gate does not run it) and `[human]`. No criterion needs `e2e`, but `pnpm test:e2e` must still pass, because `AppModule` is unchanged. No automated test reaches the network: HTTP is a fake `HttpGet`, or a loopback `node:http` server for `boundedGet` alone. Archives are built in the test from committed CSV text by a test-only zip writer in `test/fixtures/market-data/`.

**Names, CHECKSUM and CSV** (`test/unit/market-data/binance-vision.spec.ts`, `bulk-csv.spec.ts`; unit)

1. `bulkFile('BTCUSDT', '15m', 'daily', '2026-10-01')` gives:
   - `zipName` `BTCUSDT-15m-2026-10-01.zip` and `csvName` `BTCUSDT-15m-2026-10-01.csv`
   - `zipUrl` equal to `` `${BINANCE_VISION_ORIGIN}/data/spot/daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-01.zip` ``, built in the test from the imported constant
   - `range` `{ fromMs: 1790812800000, toMs: 1790899200000 }`

   The monthly `2026-09` file has range `[Date.UTC(2026,8,1), Date.UTC(2026,9,1))`. `filesFor` over `2026-09-30` to `2026-10-02` daily gives three ascending files. The same results hold under `TZ` set to `UTC`, `Europe/Ljubljana` and `Pacific/Chatham`.
2. Each of these throws, naming the argument, and builds no URL:
   - a symbol `btcusdt`, `BTC/USDT`, `../BTCUSDT`, `BTCUSDT%2F`, `BTCEUR`, or 21 characters before `USDT`
   - an interval `5m`
   - a period `weekly`
   - a date `2026-13-01`, `2026-02-30`, `2026-10-1` or `2026-10-01T00:00`
   - a monthly date in daily form, and the reverse
   - `from > to`
3. `parseChecksum` accepts `<64 hex>  BTCUSDT-15m-2026-10-01.zip\n` and the one-space form, and returns the hash. It rejects:
   - uppercase hex, 63 or 65 hex digits
   - a different file name, `../BTCUSDT-15m-2026-10-01.zip`, `dir/BTCUSDT-15m-2026-10-01.zip`
   - two lines, an empty body, a body of `MAX_CHECKSUM_BYTES + 1` bytes
4. **Property** (fast-check, ≥ 500 runs): for any symbol, interval, period and date that pass validation, `zipUrl` starts with `` `${BINANCE_VISION_ORIGIN}/data/spot/` `` and its path segments after the origin are exactly the six expected ones, with no `..`, `%` or empty segment.
5. `splitBulkCsv` over the committed 8-row fixture gives 8 lines with 12 fields each and `header: false`. `timeUnits` gives `{ us: 8, ms: 0, unreadable: 0 }`.
6. **Header.**
   - The documented header followed by the 8 rows gives `header: true` and 8 lines.
   - A header with one name changed, or with a trailing `\r`, is kept as a data row and later quarantined: rows is 9, with one `malformed_row` or `bad_timestamp` record whose `row_index` is 0.
   - A header on a line other than the first is a data row.
7. **File-level rejections**, one fixture each: invalid UTF-8 gives `bad_encoding`, a NUL byte gives `nul_byte`, a 1025-byte line gives `line_too_long`, and `2 × expectedSlots + 2` lines give `too_many_rows`. A 1024-byte line and exactly `2 × expectedSlots + 1` lines are accepted. An empty line in the middle is a row, and a single trailing newline is not.

**Archive** (`test/unit/market-data/zip-entry.spec.ts`; unit)

8. A one-entry deflate archive and a one-entry stored archive of the fixture CSV both return the exact bytes, as does an archive with the data-descriptor flag. Each of these returns `{ ok: false }` with a distinct reason and never throws:
   - two entries
   - zero entries
   - entry names `../BTCUSDT-15m-2026-10-01.csv`, `/BTCUSDT-15m-2026-10-01.csv`, `x/BTCUSDT-15m-2026-10-01.csv`, `BTCUSDT-15m-2026-10-01.csv\0.txt`, and a different `.csv` name
   - a local header name that differs from the central one
   - a directory entry
   - the encryption flag
   - method 12 (bzip2)
   - a ZIP64 marker
   - a declared size above `maxBytes`
   - a deflate stream that inflates past `maxBytes` (a zip bomb), checked with `maxBytes` small
   - a CRC mismatch
   - a declared size that differs from the inflated size
   - a truncated buffer
   - an end record pointing outside the buffer
   - 0 bytes
9. **Property** (≥ 500 runs): for arbitrary byte arrays, and for valid archives with one byte flipped, `readSingleEntry` never throws and never returns more than `maxBytes` bytes.
10. `zip-entry.ts` imports only `node:zlib`, `node:buffer` and relative modules. No file under `src/market-data/` or `src/shared/` imports `node:fs` or `node:fs/promises`, or names `writeFile`, `createWriteStream`, `mkdtemp` or `extract`.

**HTTP** (`test/unit/shared/bounded-fetch.spec.ts`, with a loopback server built in the test; unit)

11. `boundedGet` behaves as follows:
    - 200 with a body of exactly `maxBytes` gives `ok` with the body.
    - A `Content-Length` of `maxBytes + 1` gives `too_large`, and the server sees the request closed before the body is sent.
    - A chunked body that passes `maxBytes` gives `too_large`, and the client stops reading.
    - A 301 or 302 gives `redirect`, and the redirect target is never requested.
    - A server that never answers gives `timeout` within `timeoutMs` plus a margin.
    - A 404 gives `{ ok: true, status: 404 }` with an empty body.
    - Every request the server sees is a `GET`.

    No non-spec source under `src/` other than `bounded-fetch.ts` contains `fetch(`. The production `HttpGet` refuses a URL outside `` `${BINANCE_VISION_ORIGIN}/data/spot/` `` without calling `fetch`.

**Arguments** (`test/unit/market-data/backfill-args.spec.ts`; unit)

12. The full flag set parses.
    - Each required flag left out exits with code 2.
    - These are also usage errors: an unknown flag, a repeated flag, `--outlier-window 0`, `1.5` or `-1`, `--outlier-multiple 0.99`, `0`, `-1`, `1e3`, `NaN` or `Infinity`.
    - `--outlier-multiple 1` and `1000` are accepted.
    - The usage error names the flag.
    - No `HttpGet` is constructed or called on a usage error.

    A text scan finds no default value for either outlier flag in `backfill-args.ts`.

**Pipeline** (`test/unit/market-data/bulk-loader.spec.ts`, `bulk-loader.property.spec.ts`, with a fake `HttpGet` and a recording fake `CandleSink`; unit)

13. **Happy path.** For a synthetic 96-row day with µs times (a committed fixture) and a correct CHECKSUM:
    - `status: loaded`, `checksum: verified`, `rows 96`, `accepted 96`, `quarantined {}`, `missing []`
    - `timeUnits { us: 96, ms: 0, unreadable: 0 }`
    - `firstOpenTimeMs 1790812800000`, `lastOpenTimeMs 1790898300000`, `lastCloseTimeMs 1790899199999`
    - The sink receives one call with 96 candles.
    - The fake HTTP saw exactly two GETs, CHECKSUM first, then the zip, both under the origin.
14. **The summary echoes the outlier input** as `{ window, maxRangeMultiple, provisional: true }`. With window 4 and no history, `unjudged` is 5. These five bars reach the sink marked as not outlier-checked, and the other 91 are marked checked.
15. **Verify before parse.** Each case uses a spy on the archive reader and the CSV splitter.
    - A CHECKSUM whose hash differs from the zip gives `checksum_mismatch`: neither is called, and the sink is not called.
    - A CHECKSUM that returns 404 gives `not_found`, and the zip is never requested.
    - An unparseable CHECKSUM gives `checksum_unavailable`, and the zip is never requested.
    - A zip larger than `MAX_ARCHIVE_BYTES` gives `http_error` or `too_large`, and it is not hashed or opened.
    - A correct CHECKSUM over a malformed archive gives `archive_rejected`, and the sink is not called.
16. **Closed periods only.** With `asOfMs` one millisecond before a day's end, that day is refused with a `RangeError` before any GET. With `asOfMs` exactly at the end, it is requested.
17. **Every row accounted for.** Take a day with:
    - 90 valid rows
    - one each of `malformed_row`, `ohlc_inconsistent` and `bad_number`
    - two conflicting copies of one slot
    - an identical duplicate
    - one row out of order
    - one spike flagged as an outlier with window 4 and multiple 5

    The summary and the sink calls give `accepted + open + quarantined + duplicatesCollapsed = rows`. Each quarantine record reaches the sink with the `row_index` of its own CSV line and that line's original text: the two conflicting copies keep their own indexes, and the right one of two textually identical lines is chosen by identity, not by text. `missing` holds exactly the slots without an accepted candle.
18. **History is chained, and live and replay agree (D13).**
    - Over three consecutive daily fixture files, the second file's `history` is exactly the first file's `checked`.
    - **Property** (≥ 200 runs): for generated multi-day series, the accepted set, the outlier set and the unjudged set across the run equal those of one `validateKlines` call over the whole range.
    - When the middle file fails (`checksum_mismatch`), the third file's `history` is the first file's `checked`, and the run still processes the third file.
    - *Amended at human approval (2026-11-23):* as built and accepted by every reviewer, each file's `history` is the run's accumulated `checked`, trimmed to `max(window + 1, last file's checked length)`. For a 15m day with a window under 96 this equals the previous file's `checked`. For short files (4h or 1d daily), a window near 96, or a file whose rows were all quarantined, the literal "previous file's `checked`" rule would make chained runs disagree with one batch over the whole range (D13).
19. **Raw content stays out of logs and summaries.** Rows whose raw text contains these strings are quarantined:
    - `'); DROP TABLE candles; --`
    - `%s %j`
    - `\u001b[31m`
    - `{"level":60,"msg":"x"}`
    - `${process.env.X}`
    - the password-shaped sentinel `raw-sentinel-7f3a`

    Run through the loader with a captured logger (`test/fixtures/logs.ts`), no log line and no summary contains any of those strings. The sink still receives each line's full text.
20. **Exit status.** A run of three files where one is `not_found` processes all three, and the CLI's `run(argv, deps)` returns 1. All `loaded` returns 0. In a dry run the sink factory is never called, and `run` succeeds with an empty environment.

**Storage** (`test/db/candle-store.db-spec.ts`, `test/db/backfill.db-spec.ts`; db. Schema scans are unit.)

21. **Round trip and data safety.**
    - The 96 fixture candles are stored, and read back through Drizzle each money column is a string equal by `Decimal.eq` to the input.
    - `open_time_ms` and `close_time_ms` read back as the input numbers, also under `TZ=Europe/Ljubljana`.
    - `trade_count` reads back as a `bigint`.
    - `is_closed` is `true` and `source` is `'binance_vision'`.
    - Every hostile raw line from criterion 19 is stored in `market_data_quarantine.raw` and reads back byte-equal. Afterwards `candles` still exists and its row count is unchanged.
22. **Idempotent.** Loading the same fixture file twice gives:
    - the same `candles` and `market_data_quarantine` rows, compared by key and values
    - unchanged `ingested_at` and `quarantined_at`
    - a second summary with `inserted 0`, `alreadyStored 96` and `storedConflicts 0`
    - one `assets` row

    Loading a monthly 15m file of 2,976 rows succeeds in one transaction, so the chunking holds under the parameter limit.
23. **Conflict and rollback.**
    - Store a day, then load a file where one slot's `close` differs in the 18th significant digit. The stored row is unchanged, one `stored_conflict` quarantine row holds the new line, and `storedConflicts` is 1.
    - A run whose first `writeFile` left `outlier_checked = false` keeps it `false` after a second run judges the bar.
    - A forced failure in the quarantine insert (a test sink wrapper that throws after the candle insert) leaves no candle, quarantine or asset row from that file, and the summary says `store_error`.
24. **A bar after a gap** (`test/unit/market-data/validator.spec.ts`, one new test; unit). With window 2 and multiple 5, a bar whose predecessor in `S` lies two missing slots back is judged against that older close: it is flagged when its true range against that close passes the threshold, and accepted otherwise. The expected values are computed in the test, and `validator.ts` is unchanged. This pins the decision in Open decisions.
25. **Identity guard** (db). `BackfillModule` is booted on a migrated test database with `HTTP_GET` overridden by the fake.
    - With `DATABASE_IDENTITY` equal to the stored marker, it writes the fixture day.
    - With it unset or wrong, it writes no row to any table, logs the identity line, and exits 1.
    - The dry-run path, given a `DATABASE_URL` pointing at a closed port, still succeeds, because it never connects.
26. **Research role** (`test/db/research-role.db-spec.ts`, new cases; db). `research_reader` can `SELECT` from `assets`, `candles` and `market_data_quarantine`. `INSERT` into each fails with SQLSTATE `42501`.

**Schema, migrations and scans** (unit, plus `migrate.db-spec.ts` in db)

27. **Recorded-state tests, updated exactly** (Plan versus repo 3). No other existing assertion changes.
    - `schema-scan.spec.ts`:
      - The real schema's table list equals `['database_identity', 'assets', 'candles', 'market_data_quarantine']`, in export order.
      - `scanTables` with the unchanged `SERVER_FILLED_EXEMPTIONS` (still exactly `database_identity.created_at`) returns `[]`.
    - `drizzle.spec.ts`:
      - `Object.keys(schemaModule)` and the `pgTable(` count match the same four tables.
      - "creates only the marker table" becomes the exact list of `[file, table]` pairs, and the `CREATE TABLE` count is 4.
      - The DELETE/UPDATE ban strips only `ON DELETE NO ACTION` and `ON UPDATE NO ACTION`, case-insensitively, before matching. A new case shows that `ON DELETE CASCADE`, `ON DELETE SET NULL` and a bare `DELETE FROM` still fail it.
      - The `.insert(` ban allows exactly `src/market-data/candle-store.ts`.
      - `.update(`, `.delete(`, `migrate(`, and the words `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP` and `GRANT` stay banned in every non-spec source outside the migrations, `candle-store.ts` included.
      - A new case: `candle-store.ts` never names `databaseIdentity` or `database_identity`.
    - `migrate.db-spec.ts`: `MARKER_OBJECTS` is replaced by the exact object inventory after all migrations, still compared with `toEqual`. A second `db:migrate` changes nothing.
    - The journal, snapshot, `0000_init`, role, grant and insert tests pass unchanged.
28. **Server-filled time is `timestamptz(3)`.** These hold:
    - The schema scan passes on the new tables with no new exemption.
    - A new migration-text test: every `now()` in a migration after `0003` appears only as `DEFAULT now()` on a column declared `timestamp(n) with time zone` with `n` from 0 to 3. No migration after `0003` contains `now()` anywhere else (no trigger, no function).
    - No non-spec source under `src/` outside `src/db/migrations/` contains `now()`.
29. **Checks in SQL match the code.** The `reason` check list in the migration equals the exported reason constant (the validator's reasons plus `stored_conflict`), and the `timeframe` list equals the `KlineInterval` values, compared by a unit test that reads the migration text. In a db test, inserting a quarantine row with reason `bogus`, or a candle with timeframe `5m`, fails with SQLSTATE `23514`.
30. **The endpoint scan, narrowed** (`purity.spec.ts`).
    - The criterion 26 needles stay banned in every file under `src/market-data/`, `test/unit/market-data/` and `test/fixtures/market-data/`, with one exception: `src/market-data/binance-vision.ts` contains `https://data.binance.vision` exactly once, and no other URL or needle.
    - No other file under `src/` names that host. `src/config/` keeps its existing URL handling.
    - `PURE_FILES` adds `binance-vision.ts` and `bulk-csv.ts`, under the same import allow-list and hidden-input bans.
31. **Dependencies.** `package.json` `dependencies` and `devDependencies` are unchanged apart from the new `backfill` script. `pnpm install --frozen-lockfile` passes. `dependencies.spec.ts` (D9) and `no-telemetry.spec.ts` pass unchanged. A test pins `scripts.backfill` to `node --env-file=../.env dist/backfill.js`.
32. **Housekeeping.**
    - `repo-files.spec.ts`:
      - `/^- \[x\] S1b /m`.
      - Next matches `/^- S1c /m` and still says `S0 is complete`.
      - Current state › Market data names `` `bulk-loader.ts` ``, `CHECKSUM` and `` `market_data_quarantine` ``.
      - Settlements › Market data names `S1c` and `S2c`.
    - The root `.gitignore` lists `*.zip` and `*.CHECKSUM`, checked by a test.
    - `tests.json` lists every new spec once with milestone `S1`, and the existing registry tests pass.
33. **Whole job.**
    - `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm build` pass.
    - `pnpm test:db` and `pnpm test:e2e` pass after `make db-up`, with their output pasted in `build.md`.
    - No test is deleted, skipped or loosened, beyond the exact updates in criterion 27.
    - Nothing changes under `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans, `docker-compose.yml` or `.env*`.
    - The only change under `src/db/migrations/` is the one generated migration, with its snapshot and journal entry.
34. **[human] Real-file check, carried from S1a criterion 31. It is required, and S1b does not merge without it.**

    The orchestrator runs it only after the human approves this one download: two GETs to `data.binance.vision`, the `.CHECKSUM` and the `.zip` of `BTCUSDT-15m-2026-10-01`. It is run from the job worktree root, after the gate passes:

    ```sh
    . factory/env.sh
    cd local-trading-agent-backend
    pnpm build
    env -i PATH="$PATH" HOME="$HOME" node dist/backfill.js --dry-run \
      --symbol BTCUSDT --interval 15m --period daily \
      --from 2026-10-01 --to 2026-10-01 \
      --outlier-window 4 --outlier-multiple 1000
    echo "exit=$?"
    ```

    `env -i` proves that no `.env`, `DATABASE_URL` or other setting is needed. The large multiple makes this a format check, not an outlier check.

    Expected result: `exit=0`, and stdout holds exactly one JSON line with these values:

    | Field | Value |
    |---|---|
    | `file` | `"BTCUSDT-15m-2026-10-01.zip"` |
    | `status` | `"loaded"` |
    | `checksum` | `"verified"` |
    | `sha256` | 64 lowercase hex |
    | `rows` | `96` |
    | `accepted` | `96` |
    | `open` | `0` |
    | `quarantined` | `{}` |
    | `missing` | `[]` |
    | `timeUnits` | `{"us":96,"ms":0,"unreadable":0}` |
    | `firstOpenTimeMs` | `1790812800000` |
    | `lastOpenTimeMs` | `1790898300000` |
    | `lastCloseTimeMs` | `1790899199999` |
    | `duplicatesCollapsed` | `0` |
    | `outOfOrder` | `0` |
    | `unjudged` | `5` |
    | `written` | `false` |
    | `outlier` | `{"window":4,"maxRangeMultiple":1000,"provisional":true}` |

    `header` may be either value; record which one. Nothing is written to disk, and no database connection is opened.

    The orchestrator pastes the command, the full stdout and the exit code into `factory/jobs/009-bulk-loader/real-file-check.md`. If any value differs, the job goes back to the builder. Typical causes are a real header that is not recognised, a different CHECKSUM line format, or an archive feature the reader rejects. The fix comes with a new fixture that reproduces the difference.

## Rules that apply

- **External content is data (Rule 11).**
  - Archives, CHECKSUM files and rows are untrusted.
  - Names are never taken from the archive: the only accepted entry name is the one the loader computed.
  - Nothing touches disk.
  - Raw lines are stored only through bound parameters and never reach a log line or a summary (criteria 19 and 21).
- **Invalid data is quarantined, never silently used. Missing data is explicit.**
  - Every row lands in exactly one bucket (criterion 17).
  - A stored conflict quarantines the incoming row and never overwrites the stored one (criterion 23).
  - Missing ranges are reported per file.
  - A file that fails CHECKSUM or archive checks contributes nothing.
- **UNKNOWN: reconcile, verify, resume. Never blindly retry.**
  - There are no automatic retries. A failure is reported, the exit code is non-zero, and a re-run is idempotent.
  - The write path refuses an identity that is not `VERIFIED` (criterion 25).
- **No look-ahead.** Only fully closed periods are requested (criterion 16). `history` is only the previous file's `checked` (criterion 18). Unjudged bars keep `outlier_checked = false` after storage, so S3 and S7a can treat them as unverified input.
- **One implementation (D13).** The loader calls `validateKlines` unchanged. The chained run equals one batch (criterion 18).
- **Money is `Decimal`.** It is stored as string-mode `numeric`, compared with `Decimal.eq`, and never passes through a JS `number` (criteria 21, 23 and 27).
- **UTC everywhere.** Periods are UTC, times are stored as `_ms`, server-filled times are `timestamptz(3)`, and the results are checked under non-UTC `TZ` (criteria 1, 21 and 28).
- **No invented risk numbers** (master Part II §13). The outlier window and multiple are required inputs with no default, the multiple must be at least 1, and the run is labelled provisional. The byte and time limits are input-safety bounds, not trading limits.
- **No secrets, no real orders, no live endpoints in tests.**
  - The app reads no Binance key and calls only public GET URLs under one origin.
  - The automated tests use fakes only.
  - The one real download is the `[human]` criterion 34, run after approval.
  - No exchange package is added (D9 test).
- **Exits are always allowed.** Nothing here blocks an exit. The loader runs as a separate command, not inside `trader run`.
- **Schema changes go through `pnpm db:generate` and a committed migration.** They need a human. `drizzle-kit` runs only through the `db:*` scripts.
- **Never delete or skip a test to go green.** The only changed assertions are the recorded-state updates in criterion 27, each kept exact. Write tests first: every new criterion fails on today's `main`.

## Open decisions

- **SLICE_1_PLAN §11.** No §11 item blocks this job.
  - §11.5 (the universe list) does not matter here: the loader takes one symbol per run, and the full universe backfill is the human's later run.
  - §11.1 to §11.4, §11.6 and §11.7 do not touch market data.
- **Production outlier window and multiple. There is no value, and no default.** The plan gives no number, and the S1a hand-off says to fit them on the train split, which is research. Until then:
  - Every run passes them as required flags, with the multiple at least 1.
  - Summaries mark them `provisional: true`.
  - The human picks the values for the 2022 backfill.
  - `maxAgeMs` stays with S3 and S7a, because the loader does not use it.
- **Choices made here, from the plan's intent.** Reviewers and the human should confirm them.
  1. **Klines only.** Funding, metrics and premium-index bulk files, with their row schemas and tables, move to a new backlog item that must merge before S2c. `factory/` is protected, so the orchestrator or the human adds the line, for example: "S1b2 Derivatives bulk files: USDⓈ-M `fundingRate` (monthly), `metrics` (daily, off-grid rows quarantined), `premiumIndexKlines`, with CHECKSUM verification, their row schemas and tables (human)."
  2. **`assets` arrives now**, with the subset of master §4 columns, so `candles` keys on `asset_id` as master §4 and §7 say, with a foreign key. The cost is the narrowed referential-clause exception in criterion 27.
  3. **Quarantine is a table** (`market_data_quarantine`), append-only and keyed by `(source_file, row_index, reason)`. A re-run with different outlier inputs can add records, and that is intended: the table is an incident log.
  4. **A bar after a gap is still judged against the last checked close** (the S1a rule, pinned by criterion 24). It fails safe, because a flagged bar's slot goes missing and the candle stays in quarantine. Leaving it unjudged would instead admit it as an unverified candle. Revisit this with the production outlier values.
  5. **Archives stay in memory only.** Nothing is cached and nothing is written to disk, which removes zip-slip and any repo-path risk. `.gitignore` covers hand downloads.
  6. **The zip reader is in-repo, over `node:zlib`.** No zip package is added.
  7. **The write path requires a `VERIFIED` database identity.** The dry run needs no database.
