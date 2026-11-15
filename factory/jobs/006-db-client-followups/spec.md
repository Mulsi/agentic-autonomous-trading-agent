# S0f Database client follow-ups (S0e review)

## Goal

Close six small gaps that the S0e reviews left open, in the database client and the boot output. None of them changes trading behaviour. Each one makes a failure louder, closes a leak, or turns an unchecked convention into a test:

1. The `unreadable` identity line says why the read failed: it carries the SQLSTATE when there is one.
2. The marker row is validated with zod where it enters the app. A non-string marker is UNKNOWN `unreadable`, never a crash, and never reaches the log line.
3. The value scrub on the two failed-boot printers no longer misses a password that `util.inspect` escaped or split.
4. The schema scan covers `json`/`jsonb`, arrays and the integer types, and fails closed on any column type it does not know. A db test asserts that raw-pool `int8` comes back as a string.
5. Server-filled `timestamptz` columns cannot silently lose the µs-against-ms comparison (D12) after a JS round trip.
6. The stale `covers` text for `dependencies.spec.ts` in `tests.json` is fixed.

## Plan references

- Backlog S0f (`factory/backlog.md` line 13). Its sources are the S0e reviews in `factory/jobs/005-database-client/`:
  - SQLSTATE: round-1 `review-risk.md` item 5, and `decision.md` item 6.
  - Marker row zod check: round-1 `review-security.md` note 3, carried forward in round-2 note 3.
  - `util.inspect` escaping: round-1 `review-security.md` note 4.
  - Schema scan coverage: round-1 `review-quant.md` note 2, round-1 `review-risk.md` item 6, and round-2 `review-quant.md`.
  - Raw-pool `int8`: round-1 `review-quant.md` note 3.
  - D12 µs against ms: round-1 `review-quant.md` note 1.
  - Stale `covers` text: round-2 `review-security.md` note 1.
- SLICE_1_PLAN:
  - D2: zod validates external payloads. Money is `Decimal`, and Postgres `numeric` is read as a string. A plain `number` is allowed only for validated indicator math and for timestamps.
  - D11: failures are loud and nothing is swallowed.
  - D12: UTC everywhere, and both ms and µs timestamps exist.
  - D13: logic exists once, as pure TypeScript.
  - §5 S0: secrets are never logged.
  - §7: tables arrive with the milestone that first uses them.
- Master plan:
  - Part I §3, Rule 9 (UNKNOWN, reconcile, verify, resume) and Rule 11 (external content is data).
  - Part I §32: no secrets in logs.
  - Part II §4, database schema. It names columns but no types, so the slice conventions apply.
  - Part II §24: keep `progress.md` and `tests.json` current.
- `progress.md`: "Database", "Column conventions", and "Hand-offs from S0e".

## Scope

### In

**A. SQLSTATE on the `unreadable` line** (`src/db/identity.ts`, `src/db/client.ts`, `src/main.ts`)

- A failed marker read keeps the error's SQLSTATE: `{ kind: 'failed', sqlstate?: string }`.
- `sqlstate` is set only when the caught error has a string `code` that matches `^[0-9A-Z]{5}$`, which is the SQLSTATE shape. Anything else leaves it out:
  - a Node error code such as `ECONNRESET`
  - pg's client-side read timeout, which has no code
  - a non-error value
  - a malformed code sent by a stand-in server
- `decideIdentity` copies `sqlstate` onto the UNKNOWN result only when the reason is `unreadable`, and `identityLogFields` adds it as the field `sqlstate`.
- Nothing else from the error reaches the line: no message, detail, hint or stack. A stand-in server controls those fields, and they are external data (Rule 11).
- `42P01` still means `no_table`, which becomes `missing_marker`. That line gains no `sqlstate`.

**B. zod check on the marker rows** (`src/db/`)

- The rows of the marker query are parsed with zod before they become `{ kind: 'rows', markers }`.
- If the rows are not an array of objects, each with a string `marker`, the read is `{ kind: 'failed' }`, with no `sqlstate`, and the identity is UNKNOWN `unreadable`.
- This covers a number, `null`, a missing key, an object, a boolean, a Buffer and an array.
- The check lives at the boundary, in `src/db/client.ts` or a new pure module under `src/db/`. It does not go in `src/db/identity.ts`, which stays import-free, so the existing test "imports nothing at all" stays unchanged.

**C. The `util.inspect` gap in the value scrub** (`src/config/boot-output.ts`, and `src/config/secrets.ts` if the fix needs it)

- Both failed-boot printers turn values into text with `util.inspect`:
  - `printBootFailure` calls it directly.
  - `BootConsoleLogger` reaches it through Nest's `ConsoleLogger.stringifyMessage` and `stringifyParams`, for any non-string message or params.
- `inspect` quotes string values with its own escaping: `\'` when a value holds all three quote kinds, and `\x07` and similar for control characters. It also splits a long string at `\n` into `'…\n' +` pieces. None of these match the raw or JSON-escaped forms that `secretValues` returns.
- After the fix, no form of a recorded secret survives on either printer, whatever string value in the printed object holds it.
- The reviewer offered two fixes: scrub string values before inspecting, or add the inspect-escaped form. The builder chooses. The escaped form alone does not cover the newline split, and criterion 16 tests that.
- Property names are out (see Out).

**D. Schema scan coverage** (`test/fixtures/schema-scan.ts`, `test/unit/db/schema-scan.spec.ts`)

- The metadata layer becomes an allow-list of Drizzle `columnType` values. Today it is a deny-list whose `default` lets every unknown type through. Any type not listed is a violation that names the type.
- Allowed types and their rules:

  | `columnType` | Rule |
  |---|---|
  | `PgNumeric` | allowed (string mode) |
  | `PgTimestamp`, `PgTimestampString` | only with `withTimezone`, plus the D12 rule in E |
  | `PgBigInt53` | only on an SQL name ending in `_ms`, as today |
  | `PgBigInt64`, `PgBigSerial64` | allowed (JS `bigint`, never a `number`) |
  | `PgInteger`, `PgSmallInt`, `PgSerial`, `PgSmallSerial` | allowed for counts and identifiers. A violation when the SQL name ends in `_ms`, because 32 bits cannot hold epoch milliseconds |
  | `PgUUID`, `PgBoolean`, `PgText`, `PgVarchar`, `PgChar`, `PgEnumColumn` | allowed |
  | `PgArray` | allowed only when its base column, recursively, is `PgText`, `PgVarchar`, `PgChar`, `PgUUID`, `PgBoolean` or `PgEnumColumn`. The violation names the array column |

- Banned outright, each with its own rule text:
  - `PgJson` and `PgJsonb`: `JSON.parse` turns any number inside them into a JS `number`.
  - `PgBigSerial53`: an `int8` read as a JS number outside an `*_ms` column.
  - Everything already banned: `real`, `doublePrecision`, numeric in number or bigint mode, `timestamp` without a time zone, and `customType`.
  - Every type not in the table, for example `date`, `interval`, `point` and `vector`.
- The source-text layer also flags:
  - `json(` and `jsonb(`
  - `bigserial(` with `mode: 'number'`
  - `integer(`, `smallint(`, `serial(` and `smallserial(` whose name argument ends in `_ms`
  - `.array(` chained onto any builder call other than `text(`, `varchar(`, `char(`, `uuid(`, `boolean(` or an enum builder
- Only the metadata layer checks the D12 `precision` rule in E.
- The type names above are drizzle-orm 0.45's. The builder checks them against the installed version, and a renamed type must still fail closed.
- The raw-pool `int8` assertion, and the `numeric[]` and `jsonb` evidence, go in `test/db/round-trip.db-spec.ts`.

**E. D12, µs against ms** (scan rule plus db evidence)

- `now()` and Postgres's default `timestamptz` precision store microseconds. Both read paths, pg-types and Drizzle's `new Date(string)`, keep only milliseconds. So a value read into JS and compared back with `=` misses the row.
- New metadata rule: a `timestamptz` column whose default is an SQL expression (`.defaultNow()` or `.default(sql…)`) must declare `precision` 0 to 3.
- A JS-side default (`$defaultFn`) is not server-filled, so the rule does not apply to it.
- The existing `database_identity.created_at` breaks the rule. The app never reads or compares it (round-1 quant note 1). It gets one named exemption with that reason, and a test pins the exemption list to exactly that one entry. No migration: see Open decisions.

**F. Housekeeping**

- `tests.json`: in the `dependencies.spec.ts` entry, change "holds only allowBuilds and overrides" to "holds only allowBuilds, overrides and verifyDepsBeforeRun".
  - Plan and repo disagree on where this text is. The backlog and the review say `tests.json:808`, which was the S0e worktree's layout. On `main` the entry is on line 180. The intent, fixing that entry's text, is what this spec asks for.
- Add every new spec file to `tests.json`, and update the `covers` text of every changed one.
- `progress.md`:
  - "Column conventions": the allow-list, the integer, array and JSON rules, and the server-filled `precision` rule with its one exemption.
  - "The identity check": `sqlstate` on the `unreadable` line, and the zod check on the marker rows.
- Update the conventions comment at the top of `src/db/schema.ts` to match.
- Add test fixtures where needed. One example is new `fakePostgres` modes that answer the first query with an ErrorResponse carrying a given SQLSTATE, or with one DataRow of a given type OID and value.

### Out

- A pool-level `error` listener and DB health after boot. That is S11a.
- Re-reading `database_identity.marker` inside the risk-approval transaction. That is S7b.
- Moving the `research_reader` password out of migration 0003. That is S11b.
- Logging Node error codes, messages or any other error field on the identity line. Only a validated SQLSTATE is in scope.
- Checking that a string marker is a UUID. A wrong string is already `mismatch`.
- Scrubbing secrets that appear in property names, Symbol keys or getters. `inspect` does not call getters by default.
- Changing the pino path. It serialises JSON, and `secretValues` already has the JSON-escaped forms.
- Any new table, column, migration or type parser. Any change to the identity decision beyond carrying `sqlstate`.
- Round-1 risk items 4, 7 and 8, and the other carried-over notes, except where listed under In.

## Acceptance criteria

Each criterion names its suite. The factory gate runs only `pnpm test` (`unit`). For `db` and `e2e` criteria, the builder pastes passing `pnpm test:db` and `pnpm test:e2e` output in `build.md`, after `make db-up` and `pnpm build`.

### A. SQLSTATE

1. `unit` `markerReadFailure` (or its replacement) returns `{ kind: 'failed', sqlstate: C }` for an error whose `code` is each of `'XX000'`, `'22012'`, `'57P01'` and `'42501'`.
   - It returns `{ kind: 'failed' }` with no `sqlstate` key for each of: code `'ECONNRESET'`, no code, a numeric code, `'xx000'`, `'XX00'`, `'XX0000'`, `'XX00"'`, `null`, a string thrown as the error, and `undefined`.
   - It still returns `{ kind: 'no_table' }` for `'42P01'`.
2. `unit` A fast-check property over arbitrary `code` values: `sqlstate` is present exactly when `code` is a string that matches `^[0-9A-Z]{5}$` and is not `'42P01'`. When present, it equals `code`.
3. `unit` `decideIdentity`:
   - A configured marker and a failed read with `sqlstate: 'XX000'` give `{ status: 'UNKNOWN', reason: 'unreadable', sqlstate: 'XX000' }`.
   - A failed read without one gives no `sqlstate` key.
   - The same failed read with no configured marker gives `not_configured`, with no `sqlstate`.
   - No result with any other reason ever carries `sqlstate`. This is a property over every `MarkerRead` shape.
4. `unit` `identityLogFields` includes `sqlstate` when the identity has one, and leaves it out otherwise. The existing cases for VERIFIED and `missing_marker` are unchanged.
5. `unit` Through `connectDatabase` against a fake server that answers the marker query with an ErrorResponse:
   - With SQLSTATE `XX000`, the read is `{ kind: 'failed', sqlstate: 'XX000' }`. The process does not crash, the pool closes cleanly, and the server saw one query and no retry.
   - With the malformed code `X"0 0`, the read is `{ kind: 'failed' }`.
   - The ErrorResponse's message field holds a sentinel string. That sentinel appears in no field of the read, the identity or `identityLogFields`.
6. `unit` The existing reset-on-query and silent-on-query cases in `marker-read.spec.ts` still pass, and their reads have no `sqlstate` key.
7. `db` On a throwaway database where `database_identity` is a view whose `marker` column raises `division_by_zero`, `connectDatabase` returns `{ kind: 'failed', sqlstate: '22012' }`, and the identity is UNKNOWN `unreadable` with `sqlstate: '22012'`. For example: `CREATE VIEW database_identity AS SELECT (1/0)::text AS marker`.
8. `e2e` A boot against the fake server in ErrorResponse mode with SQLSTATE `XX000` exits 0 and logs exactly one `warn` identity line, before the startup line, with `status: 'UNKNOWN'`, `reason: 'unreadable'` and `sqlstate: 'XX000'`. The line has no `marker` and does not contain the sentinel message. The existing reset and timeout e2e cases assert that their identity lines have no `sqlstate` property.

### B. Marker rows through zod

9. `unit` The row check, called directly:
   - It returns `{ kind: 'rows', markers }` for `[]`, for one row, and for two rows of `{ marker: <string> }`. The markers come back in order and unchanged, including `''` and whitespace.
   - It returns `{ kind: 'failed' }`, with no `sqlstate`, for:
     - rows whose `marker` is `7`, `7n`, `null`, `undefined`, `true`, `{}`, `[]` or `Buffer.from('x')`
     - a row with no `marker` key
     - a row that is `null`
     - one valid row next to one invalid row
     - a non-array rows value
   - It never throws. This is a fast-check property over `fc.anything()` rows.
10. `unit` Through `connectDatabase` against a fake server that answers the marker query with one DataRow:
    - With an `int4` column (OID 23) holding `7`, the read is `{ kind: 'failed' }`.
    - With a `NULL` value, the read is `{ kind: 'failed' }`.
    - In both cases `decideIdentity` gives UNKNOWN `unreadable` with no `marker` key, and no exception escapes.
    - Control: the same fake with a `text` column (OID 25) holding a marker string gives `{ kind: 'rows', markers: [<that string>] }`.
11. `db` Two stand-in databases built by hand, not migrated: one with `database_identity(marker integer)` holding `7`, one with `database_identity(marker text NULL)` holding `NULL`. On each, `connectDatabase` resolves, the read is `{ kind: 'failed' }`, and the identity is UNKNOWN `unreadable` with no `marker`.
12. `unit` `src/db/identity.ts` still imports nothing: the existing test "imports nothing at all" is unchanged and passes. The source that holds the row check imports `zod`. No type assertion on the query rows remains (no `client.query<{ marker: string }>`, no `as { marker: string }`): the rows reach the zod parse as `unknown` before any use.

### C. The `util.inspect` gap

13. `unit` A fast-check property, at least 300 runs, over passwords `prefix + CORE + suffix`:
    - `CORE` is a fixed alphanumeric sentinel of at least 12 characters.
    - `prefix` and `suffix` are arbitrary strings drawn to include `'`, `"`, `` ` ``, `\`, `\n`, `\r`, `\t`, U+0000 to U+001F, U+007F and non-ASCII, excluding lone surrogates.
    - The `DATABASE_URL` is `postgresql://trader:<encodeURIComponent(password)>@localhost:5432/trader`, and only URLs that `parseSettings` accepts are used.
    - With `recordBootSecrets(secretValues(settings))`, `printBootFailure` writes no `CORE` to stderr for an error that holds the password in each of these places:
      - an own enumerable property equal to it
      - an own enumerable property that embeds it in text
      - a nested plain object at depth 2 and at depth 3
      - an array element
      - an enumerable property of its `cause`
      - an entry of an `AggregateError`'s `errors`
      - a `Map` value
    - Each placement is tested with the decoded password, the `url.password` form and the URL as loaded.
14. `unit` Control for 13: with `recordBootSecrets([])`, the same generated errors print `CORE`. This proves the oracle catches a leak.
15. `unit` The reviewer's probe. With the password exactly `a'b"c` + backtick + `d\x07e`, and an error whose enumerable property holds it:
    - `printBootFailure` output contains neither the raw value, nor its JSON-escaped form, nor `inspect(value).slice(1, -1)`.
    - Control: with no recorded secrets, the output contains `inspect(value).slice(1, -1)`.
16. `unit` A password longer than 80 characters with a `\n` in its middle, which `inspect` splits across lines, held in a nested property: neither half of it appears in `printBootFailure` output. A control with no recorded secrets shows that `inspect` really splits it, so that both halves appear on separate lines.
17. `unit` `BootConsoleLogger` gives the same result as 13, with fewer runs (at least 50), for:
    - `logger.error(error)`, where `error` has an enumerable property holding the password
    - `logger.log(object)`, where `object` is a plain object holding it at depth 2
    - Stdout and stderr together contain no `CORE`.
    - A control with no recorded secrets shows `CORE`.
18. `unit` Nothing else changes:
    - `printBootFailure` still sets `process.exitCode = 1`.
    - It still prints the error's class name, its `code` (`28P01`) and a non-secret property value unchanged.
    - An error with a circular reference prints without throwing, and the text contains `[Circular`.
    - Every existing test in `boot-output.spec.ts`, `secrets.spec.ts`, `secrets.property.spec.ts`, `logging.spec.ts` and `app-logger.spec.ts` passes unchanged.
19. `e2e` The existing failed-boot cases (e.g. criterion (e) in `database-boot.e2e-spec.ts`) still show `[REDACTED]` and no password.

### D. Schema scan

20. `unit` The real schema still passes both layers, and `scanTables` still finds exactly `database_identity`.
21. `unit` Each new banned form fails the metadata layer, with exactly one violation that names the fixture table and column `price`. Each also fails the source layer on the matching text:
    - `json('price')`
    - `jsonb('price')`
    - `bigserial('price', { mode: 'number' })`
    - `integer('price_ms')`, and the same for `smallint`, `serial` and `smallserial`. Here the column is `price_ms`.
    - `real('price').array()`
    - `numeric('price').array()`
    - `numeric('price', { mode: 'number' }).array()`
    - `integer('price').array()`
    - `timestamp('price', { withTimezone: true }).array()`
    - `real('price').array().array()`, a nested array
22. `unit` A column type outside the allow-list fails the metadata layer with a rule that names its `columnType`. Use at least `date('price')`, `interval('price')` and `point('price')`.
23. `unit` The allow-list fails closed. A column whose `columnType` the scan has never seen, built by stubbing `columnType` on a real column, is a violation.
24. `unit` These pass both layers:
    - `integer('count')`, `smallint('rank')`, `serial('id')` and `smallserial('id')`
    - `bigserial('id', { mode: 'bigint' })` and `bigint('n', { mode: 'bigint' })`
    - `uuid`, `boolean`, `text`, `varchar`, `char` and a `pgEnum` column
    - `text('tags').array()`, `uuid('ids').array()` and `boolean('flags').array()`
    - Every form that passed before this job
25. `db` In `round-trip.db-spec.ts`, under `TZ=Europe/Ljubljana`:
    - Raw-pool `int8`: `SELECT 9007199254740993::int8` and an `int8` column holding the same value both come back through `connection.db.$client.query` as the string `'9007199254740993'`, with `typeof` `'string'`.
    - Raw-pool `jsonb`, a control for the JSON ban: `SELECT '{"p": 0.10}'::jsonb` comes back with `typeof p === 'number'`.
    - `numeric[]`: the value `'{1.10,-0.00000001}'` is read through the raw pool and through Drizzle (`numeric('v').array()`), and the test asserts exactly the element values and `typeof` that come back on each path. `build.md` records the result. The scan bans numeric arrays either way. If they come back as anything but the identical strings, that is the reason the ban exists.
26. `unit` With no database, after importing `src/db/client.ts`:
    - `pg.types.getTypeParser(20, 'text')('9007199254740993')` is the string `'9007199254740993'`.
    - `pg.types.getTypeParser(1700, 'text')('1.10')` is `'1.10'`.
    - The existing "no `setTypeParser` under `src/`" test is unchanged.

### E. D12, µs against ms

27. `unit` These fail the metadata layer, each naming the table and the column:
    - `timestamp('at', { withTimezone: true }).defaultNow()`
    - `timestamp('at', { withTimezone: true, precision: 6 }).defaultNow()`
    - `timestamp('at', { withTimezone: true }).default(sql\`now()\`)`
28. `unit` These pass:
    - `timestamp('at', { withTimezone: true, precision: 3 }).defaultNow()` and the same with `precision: 0`
    - `timestamp('at', { withTimezone: true })` with no default
    - `timestamp('at', { withTimezone: true }).$defaultFn(() => new Date())`
29. `unit` The scan's exemption list is exactly `[{ table: 'database_identity', column: 'created_at' }]`, with a reason. Without the exemption, the real schema fails on that column. An exemption entry naming a column that does not exist in the scanned tables is itself a violation, so a stale exemption cannot linger.
30. `db` On a throwaway database, `fx_now(id int, at6 timestamptz, at3 timestamptz(3))` with both columns server-filled from the literal `'2024-01-15 12:00:00.123987+00'`:
    - Each column is read through Drizzle into a `Date`.
    - `WHERE at6 = $1` with the `Date` read from `at6` finds 0 rows. This demonstrates the hazard.
    - `WHERE at3 = $1` with the `Date` read from `at3` finds 1 row.
    - The same holds through the raw pool.
31. `db` On the same database, 20 rows inserted with `at3 DEFAULT now()` into a `timestamptz(3)` column: every row is found again by `=` on the `Date` read back through Drizzle.

### F. Housekeeping

32. `unit` In `repo-files.spec.ts`, the `tests.json` entry for `local-trading-agent-backend/test/unit/tooling/dependencies.spec.ts` contains "holds only allowBuilds, overrides and verifyDepsBeforeRun", and does not contain "holds only allowBuilds and overrides".
33. `unit` The existing `tests.json` checks pass: every spec is listed exactly once, and every listed file exists.
34. `unit` `progress.md` "Current state" names `sqlstate`, `jsonb` and `precision`, which `repo-files.spec.ts` pins. Every existing `progress.md` pin still passes.
35. `unit` `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. No existing test is deleted, skipped or weakened. `package.json` and `pnpm-lock.yaml` are unchanged: `zod`, `fast-check` and `pg` are already there.

## Rules that apply

- **Secrets are never logged (§5 S0, master §32).** Part C exists for this rule. The SQLSTATE field must not open a new path for server text into the log.
- **UNKNOWN blocks entries; reconcile, verify, resume (Rule 9).**
  - Every new failure, whether a malformed row or an error with a SQLSTATE, must end at UNKNOWN `unreadable`, never at `VERIFIED` and never at a crash.
  - `VERIFIED` stays reachable from exactly one place, on an exact match.
  - `blocksEntries` is unchanged.
  - The boot still never fails on the identity, so exits keep running.
- **External content is data (Rule 11).** A stand-in server controls the row values and the error fields. Only the validated 5-character SQLSTATE and string markers pass.
- **Money is `Decimal`; `numeric` is read as a string (D2).** Part D must not let a money-capable column type that reads as a JS `number` pass the scan. No type parser changes.
- **UTC everywhere; ms and µs (D12).** Part E.
- **One implementation (D13).** The identity logic stays pure TypeScript with no Nest, `pg` or Drizzle import.
- **Invalid data is quarantined, never silently used.** A malformed marker row is UNKNOWN, never coerced.
- **Never delete or skip a test to go green.**
  - The `identity.ts` "imports nothing at all" test and the `setTypeParser` ban stay unchanged.
  - A test that asserted an old deny-list result may change only because the scan now rejects more, and `build.md` names it.
- **Factory agents never read `.env`** and test against fixtures and throwaway `trader_test_*` databases only.

## Open decisions

None of SLICE_1_PLAN §11's items applies to this job.

The job touches `src/config/` (`boot-output.ts`, and maybe `secrets.ts`), so it needs a human. The human should also confirm these choices, which the spec makes because the S0e reviews left them open:

1. **The schema scan becomes an allow-list** (risk item 6), not a longer deny-list.
   - The integer family is allowed for counts and identifiers, because 32-bit values are exact in JS and hold no fraction. The scan cannot tell a count from money in minor units, so the convention says integers never hold money or time, and the `_ms` rule catches the time case.
   - Default: as written in D.
2. **`json`/`jsonb` are banned** until a job needs one and defines how money inside it stays a string (risk item 6, quant note 2). Default: banned.
3. **Arrays are allowed only of text-like, `uuid`, `boolean` and enum elements.** Numeric, integer and time arrays fail closed, whatever criterion 25 finds. Default: as written.
4. **`database_identity.created_at` gets a pinned exemption** from the server-filled `precision` rule, not a migration to `timestamptz(3)`. Nothing reads or compares it, and a migration would add a protected change to this job.
   - Alternative: a migration `ALTER COLUMN created_at TYPE timestamptz(3)`, and drop the exemption.
   - Default: the exemption.
5. **The field is named `sqlstate`** and is validated against `^[0-9A-Z]{5}$`. Node error codes are not logged. Default: as written.
