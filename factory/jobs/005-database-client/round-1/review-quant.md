VERDICT: PASS

## Findings

No blocking findings.

This job has no market data, indicators, splits, fills or EV. That means no look-ahead, no train or test split, no Wilder smoothing, no fill model and no EV bucket to check. The quant-relevant parts are the money and time conventions, the type parsers, the round trip under a non-UTC zone, and whether the identity decision is deterministic. I checked each one against the code and by hand.

### What I verified

- **No type parser changes.** `src/db/client.ts` has no `setTypeParser`. `numeric` stays a string through both paths (the round-trip spec, lines 155-171). M6 (`setTypeParser(1700, parseFloat)`) fails the source check and both numeric round-trip tests, because `'1.10'` would come back as `1.1`. Drizzle's node-postgres session overrides only the parsers for TIMESTAMPTZ, TIMESTAMP, DATE and INTERVAL, and it falls back to the global parsers for everything else. So the Drizzle path really would see a global parser change.
- **Session zone.** `options: '-c TimeZone=UTC'` (client.ts:62) pins the session to UTC whatever the server says (D12), and `client.db-spec.ts:96-99` asserts it. Drizzle's `PgTimestamp.mapToDriverValue` sends `toISOString()`, so every write carries an explicit `Z`.
- **Instants in the round trip** (`test/db/round-trip.db-spec.ts`), checked by hand:
  - 2024 EU summer time ends at 01:00Z on 27 Oct. `00:30Z` is 02:30 CEST and `01:30Z` is 02:30 CET: the same local time, an hour apart, as the test asserts at line 101.
  - Summer time begins at 01:00Z on 31 Mar. `00:59:59.999Z` is 01:59:59.999 CET, the last millisecond before the change.
  - The raw-pool read goes through pg-types, which does not depend on Drizzle's write path. So a stored instant that is wrong would fail the raw test even if Drizzle's own write and read cancelled each other out.
- **Zone control** (lines 173-187). The literal `'2024-01-15 12:00:00'` is stored as `timestamp without time zone`, and pg-types parses it as local time, which is 11:00Z in Ljubljana. `read - utc = -3_600_000`, which equals `getTimezoneOffset() (-60) * 60_000`. The arithmetic is right, and it shows the process zone is in effect. The session's UTC setting does not affect this, because a naive timestamp's text has no offset.
- **Numeric strings.** Unconstrained `numeric` keeps the input's digits and display scale. So `'1.10'`, `'-0.00000001'` and the 48-digit value come back byte-identical, and the test asserts `typeof === 'string'` on the raw path.
- **`_ms` bigint.** Drizzle's `PgBigInt53` maps with `Number()`. Epoch milliseconds are about 1.7e12, far below 2^53, so the value is exact.
- **Schema scan** (`test/fixtures/schema-scan.ts`). I checked the column type names against the installed drizzle-orm 0.45: `PgReal`, `PgDoublePrecision`, `PgNumericNumber`, `PgNumericBigInt`, `PgBigInt53`, `PgTimestamp`, `PgTimestampString` and `PgCustomColumn` all exist. `PgTimestamp.withTimezone` is a real field. The `_ms` rule tests the SQL name (`column.name`), as the spec requires. Both layers fail closed on forms they cannot parse: an option object passed as a variable, or an unnamed `bigint`. The fixtures are hand-declared tables, not output of the code under test.
- **Identity decision** (`src/db/identity.ts`).
  - It is pure and deterministic: no imports and no `process.`.
  - `VERIFIED` is returned from one place only, and only on an exact match with exactly one row.
  - `limit(2)` lets a second row be seen and read as `unreadable`.
  - `blocksEntries` is `status !== 'VERIFIED'`, so a corrupt status blocks too.
  - The blank check (`trim() === ''`) is the same in `settings.ts` and in `decideIdentity`.
  - The e2e expected markers come from a separate raw `SELECT marker::text` (`markerRows`), not from the app.
- **D13.** The decision and the predicate exist once, in pure TypeScript, for S7a to use. No Python logic was added; `research/` changes only its README.

### Non-blocking notes for later jobs

1. **D12, µs against ms** (`src/db/schema.ts:24`). `created_at ... DEFAULT now()` stores microseconds. Both read paths, pg-types and Drizzle's `new Date(string)`, truncate it to milliseconds. That is harmless here, because nothing compares `created_at`. But any later `timestamptz` column that the server fills and that is then compared, deduplicated or used as a key after a round trip through JS should use `precision: 3` or an `_ms` column. Otherwise an equality on a value that went through JS silently fails to match.
2. **Gaps in the scan's metadata layer** (`test/fixtures/schema-scan.ts:18-43`).
   - `real('x').array()` and `numeric('x', { mode: 'number' }).array()` report `columnType` `PgArray`, and the switch's `default` lets them through. The source-text layer still catches the literal forms, so this is covered today.
   - `json`/`jsonb` columns are not scanned. `JSON.parse` turns any money inside them into a JS `number`.
   - `integer`, `smallint` and `serial` are not scanned either (builder note 7).

   The first job that adds an array, a JSON or an integer column that could hold money should extend the scan: recurse into `PgArray.baseColumn`, and decide what to do about JSON.
3. **The raw-pool path for `int8` is not asserted to stay a string.** Only the Drizzle path is checked. Criterion 1's ban on `setTypeParser` in the source covers the realistic way that could regress, so this is a note only.
