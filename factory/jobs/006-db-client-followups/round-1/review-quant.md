VERDICT: PASS

## Scope of this review

The job has no market data, indicators, fills, EV or train/test splits. The quantitative content is the column-type scan (D), the D12 µs-against-ms rule (E), and the db evidence for int8, jsonb and numeric[] in `test/db/round-trip.db-spec.ts`. I checked these by hand, and against the installed drizzle-orm 0.45.4 and pg-types 2.2.0 sources. Parts A to C (SQLSTATE, the marker-row zod check, the inspect scrub) carry no math. I checked them only for determinism and for oracles that are independent of the code.

## Checked, correct

- **The D12 evidence values are hand-correct, not produced by the code.**
  - Postgres rounds `timestamptz(3)` to the nearest unit, so `.123987` gives `.124`. A JS read of the µs column drops the fraction past ms, so `.123987` gives `.123`. The assertions `12:00:00.123Z` (at6) and `12:00:00.124Z` (at3) in `test/db/round-trip.db-spec.ts` are both right.
  - Therefore `= $1` with at6's Date compares `.123000` against `.123987` and gets 0 rows. With at3's Date it compares `.124` against `.124` and gets 1 row.
  - The 20-row `DEFAULT now()` case runs one autocommit insert per row, so each row has its own `now()`. That makes it a real test of the positive case.
- **int8 beyond 2^53.**
  - The test value is `9007199254740993` = 2^53 + 1, the smallest positive integer a double cannot hold. A silent `number` parse would show as `...992`.
  - In pg-types 2.2.0, `register(20, parseBigInteger)` returns the string. Drizzle in bigint mode returns `9007199254740993n`. Both expectations are exact.
- **The numeric[] evidence.**
  - In pg-types, `register(1231, parseFloatArray)` makes the raw-pool result `[1.1, -1e-8]`.
  - In Drizzle's `node-postgres/session.js`, the `typeId === 1231` branch returns the raw text. `PgArray` and `PgNumeric` then keep `'1.10'` and `'-0.00000001'`.
  - The round 1b correction asserts library behaviour that a real run observed, and the expected strings are the literal stored values. It is not a fixture that the app's code produced. The ban rests on the raw-pool path, and that is correct.
- **The allow-list matches the spec table exactly** (`test/fixtures/schema-scan.ts`, `PLAIN_ALLOWED`, `INTEGERS`, `TIMESTAMPS`, `ARRAY_ELEMENTS`, `BANNED`).
  - `PgNumeric` is the string mode only: drizzle 0.45 gives number mode and bigint mode their own `PgNumericNumber` and `PgNumericBigInt` classes.
  - Any other `columnType` falls to `not on the allow-list`, including `PgEnumObjectColumn`, the vectors, the geometry types, `PgTime`, `PgInet` and `PgDate`.
  - `KNOWN_COLUMN_TYPES` is pinned against types built from the installed drizzle. A rename therefore fails closed in the scan and also fails that test.
- **Arrays.** `arrayElement` unwraps every `PgArray` level, so `real().array().array()` is caught. Its test case is in the spec.
- **The precision rule.**
  - `PgTimestamp` and `PgTimestampString` both expose `precision` and `withTimezone` as instance fields (drizzle `pg-core/columns/timestamp.js`, lines 19–24 and 55–60), so the rule reads real metadata.
  - The rule fires on `column.default !== undefined`. `.defaultNow()` and `.default(...)` set `default`. `$defaultFn` sets `defaultFn` instead, so it is exempt, as the spec intends.
  - Applying the rule to literal defaults too is stricter than the spec, and correct: a literal can carry µs.
- **Exemptions.** The stale-exemption logic uses identity on the entry objects, and only the precision rule can be exempted, never a type violation. The list is pinned to exactly one entry.
- **Source-layer regexes.**
  - `\bserial\(` cannot match inside `bigserial(` or `smallserial(`, because there is no word boundary there.
  - `jsonb?` and the `_ms` integer rules match the criterion-21 forms.
  - `.array(` resolves to the root of its call chain and fails closed when it cannot trace the chain.
- **The SQLSTATE property's oracle** (`test/unit/db/identity.spec.ts`) is an independent regex literal taken from the spec, not an import of `SQLSTATE` from `identity.ts`. The property runs are deterministic fast-check assertions over pure functions.

## Findings

None blocking.

## Non-blocking notes for later jobs

1. **The scan sees only Drizzle defaults** (`test/fixtures/schema-scan.ts`, `serverFilledViolation`). The same D12 hazard returns, unseen by the scan, when a later job writes `now()` in SQL into a plain `timestamptz` (precision 6):
   - `INSERT ... VALUES (now())`
   - `UPDATE ... SET updated_at = now()`
   - a trigger

   The `progress.md` convention text says "a timestamptz the server fills". Either S7 or the first job with a server-written timestamp should state that any column the server writes, by any path, uses `timestamptz(3)`. An alternative is to make precision 3 the default for every `timestamptz`.
2. **The raw-pool results are not covered by the column scan.** A raw-pool query that returns `numeric[]`, such as `array_agg(price)`, or a `jsonb` result, such as `jsonb_build_object('p', price)`, yields JS numbers whatever types the columns have. The ban covers declared columns only. Jobs that read money through `connection.db.$client` should go through Drizzle or cast to `text`/`text[]`. This may deserve a line under "Column conventions".
3. **`generatedAlwaysAs` columns.** A `timestamptz` generated column is server-filled, but it has no `default`, so the precision rule skips it. It is low risk: a generated expression must be immutable, so it cannot call `now()`. It can only derive from another column, and that column falls under the rule.
