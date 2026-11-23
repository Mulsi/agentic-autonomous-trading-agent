VERDICT: PASS

Scope: branch `factory/009-bulk-loader` (commit `2c00bdc`) against `main`. I read the whole source diff and checked the security-relevant tests. Nothing was run. No Docker was used and no network was contacted.

## Findings

No blocking findings.

### What was checked and holds

**Secrets**
- No Binance credential, API key or `ANTHROPIC_API_KEY` appears anywhere in the diff.
- The only credential-shaped string is `local-dev-only` in the closed-port DSN in `test/db/backfill.db-spec.ts`. It is a throwaway test value.
- `backfill.ts` never prints an error message:
  - The dry run prints only `errorName` (`src/backfill.ts:62-65`, `:113-116`).
  - A failed write run logs only the class name (`:150-155`).
  - A boot failure goes through the existing scrubbed `printBootFailure`.
- A store failure reports only a well-formed SQLSTATE (`src/market-data/bulk-loader.ts:301-315`).
- `BackfillModule` builds pino with `loggerOptions(secretValues(settings))`, as `AppModule` does.
- The Drizzle client has no query logger (`src/db/client.ts`), so the bound parameters, including raw lines, are never logged.

**Claude boundary**
- Not in scope. This job has no Claude, no tools and no snapshot path.
- The quarantine table holds untrusted text. `research_reader` can read it through the existing default grants, but nothing in this job passes it to Claude.

**Network**
- `fetch(` exists only in `src/shared/bounded-fetch.ts:57`. The call uses `method: 'GET'`, `redirect: 'error'` and `AbortSignal.any([timeout, controller])`.
- The timeout signal covers the body read as well as the headers.
- A `Content-Length` over the cap is refused before the body is read (`:67-76`).
- The streamed count aborts the request as soon as it passes `maxBytes` (`:85-93`). undici decodes `Content-Encoding` before the stream reaches this code, so the count is taken after decoding, and a compressed transport bomb is capped too.
- The production `HttpGet` (`src/market-data/vision-http.ts:20-40`) requires the `https://data.binance.vision/data/spot/` prefix. After the prefix, the path may hold only `[A-Za-z0-9_.-]` segments, and no segment may be all dots. So `%`, `?`, `#`, `@`, `//` and `..` are all refused before fetch.
- The tests cover the `.evil.example` and `@evil.example` host tricks with fetch spied (`test/unit/shared/bounded-fetch.spec.ts`).
- There is no order, account or withdrawal endpoint. The URLs are built only from validated segments (`binance-vision.ts:129-165`). The symbol regex `^[A-Z0-9]{1,20}USDT$` and the strict date regexes leave no room for traversal.
- The purity scan is narrowed exactly: one origin, once, in one file, and no other URL in that file.
- No automated test reaches the network. Tests use `FakeHttp` or a `127.0.0.1` server. `backfill.db-spec.ts` overrides `HTTP_GET` and passes its own `dryRunHttp`.

**CHECKSUM ordering** (`bulk-loader.ts:341-399`)
1. The CHECKSUM is fetched first, capped at 1 KiB, decoded as strict UTF-8 and parsed. The zip is not requested if the CHECKSUM GET fails, returns a non-200 status, or does not parse.
2. The zip is fetched with an 8 MiB cap.
3. The SHA-256 over the exact downloaded bytes is compared with the published value. Only after that is `readSingleEntry` called.

`parseChecksum` requires 64 lowercase hex and an exact name match, and allows no `\r` or second line. The tests spy on the reader, the splitter and `hash` to prove this order.

**Zip reader** (`src/market-data/zip-entry.ts`)
- Every read goes through a bounds-checked `Reader`. `inBounds` requires safe integers, non-negative values and `offset + length <= length`.
- The reader rejects:
  - more than one end record whose comment runs to the end of the buffer
  - ZIP64 (locator, `0xffff`/`0xffffffff` sentinels and the extra field), checked in both the central and the local header
  - multi-disk archives
  - an entry count other than 1
  - a central size that does not equal 46 + name + extra + comment
  - encryption (bits 0, 6 and 13)
  - a directory, by trailing `/`, DOS attribute or Unix attribute
  - any name that is not byte-equal to the computed `csvName`
  - a local name or method that differs from the central one
  - local CRC or sizes that differ from the central ones when bit 3 is clear
  - data that would overlap the central directory
  - a declared size over the cap
- `inflateRawSync` is capped with `maxOutputLength`. Inflated length and CRC-32 are both checked, and the result is copied out of the archive buffer.
- Anything unforeseen becomes `malformed`, never a throw.
- `hasZip64Extra` always moves forward by at least 4 bytes, so a crafted extra field cannot make it loop forever.
- The end-record scan is bounded at 65,557 offsets.
- The entry is never written to disk, and no `node:fs` appears under `src/market-data/` or `src/shared/`, so zip-slip has no path to work through.

**Untrusted CSV**
- Strict UTF-8 is required, and a NUL byte, a line over 1024 bytes or more than `2 × slots + 1` lines rejects the whole file. A BOM is kept as data (`ignoreBOM: true`), so the header no longer matches and that row is quarantined.
- Rows go through the unchanged S1a `validateKlines`.
- Summaries hold counts, enum reasons, times, the computed zip name and the computed sha256. Nothing in them comes from a row. Criterion 19 tests this with hostile strings, in both the logs and the dry-run stdout.

**Quarantine storage and SQL**
- Writes use only the Drizzle builder with bound parameters: `insert ... onConflictDoNothing`, and `select ... where eq/inArray`.
- There is no `sql.raw`, no `.update(` and no `.delete(`. The only raw `sql` templates are the CHECK constraints in `schema.ts`, and they interpolate column references only.
- Hostile raw lines such as `'); DROP TABLE candles; --` round-trip byte-equal in `candle-store.db-spec.ts`, and the `candles` table survives.
- The CHECK constraints on `reason` and `timeframe` match the code, and a test compares the migration text with the constants.
- Each file is stored in one transaction and rolls back as a whole.
- The write path refuses any identity that is not `VERIFIED` before it makes a request (`backfill.ts:126-137`).

**`backfill` script and CLI**
- `"backfill": "node --env-file=../.env dist/backfill.js"` mirrors `start:prod` and is for the human only.
- The dry run builds no Nest context, reads no settings and opens no connection (tested against a closed port).
- `argv` is parsed strictly with zod. Unknown, repeated or missing flags give exit code 2 with no HTTP object created.

**Dependencies**
- `dependencies` and `devDependencies` are unchanged, and the lockfile is unchanged.
- Only `node:zlib`, `node:crypto` and built-in `fetch` are used. There is no new install script or telemetry.

**Other**
- `src/` has no `eval`, `new Function`, `child_process`, `JSON.parse` of downloaded data, or `process.env` read in the new files.
- The root `.gitignore` adds `*.zip` and `*.CHECKSUM` as defence in depth.

### Non-blocking notes

1. **Quarantine provenance** (`src/market-data/candle-store.ts:210-230`; PK `(source_file, row_index, reason)`).
   - If Binance republishes a file under the same name with different content, a new quarantined line at an index and reason already recorded is dropped by `ON CONFLICT DO NOTHING`. The table keeps the old text.
   - The run summary still counts the record, so this is not silent in the logs.
   - A later job could add the archive `sha256` to the quarantine row, or to its key. This is data integrity, not a security defect.
2. **CHECKSUM scope.** The CHECKSUM comes from the same origin as the zip, so it proves integrity in transit and on the mirror, not authenticity. TLS to the one pinned origin provides authenticity. This is inherent to the plan and is acceptable.
3. **Redirect label** (`src/shared/bounded-fetch.ts:21-28`). The redirect is recognised by matching undici's `cause.message` against a regex. If undici's wording changes, a redirect would be reported as `network`. It would still never be followed, because `redirect: 'error'` is set.
4. **Future consumers.** `market_data_quarantine.raw` is attacker-influenced text that `research_reader` can read. Any later job that shows it to Claude or puts it in a report must treat it as data (Rule 11). No such path exists in this job.
