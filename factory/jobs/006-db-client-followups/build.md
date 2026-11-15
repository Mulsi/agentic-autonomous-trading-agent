# Build: 006-db-client-followups (S0f)

Branch `factory/006-db-client-followups`. The first commit is `5198610`. The second commit (round 1b, below) corrects the Drizzle `numeric[]` test after the real run. No change to `package.json`, `pnpm-lock.yaml`, migrations, `factory/`, `.claude/`, `CLAUDE.md` or the plans.

## Status (at the round 1b commit, against this worktree's compose Postgres)

| Command | Result |
|---|---|
| `pnpm test` | pass: 28 files, 700 tests |
| `pnpm lint` | pass |
| `pnpm build` | pass (typecheck, then nest build) |
| `pnpm test:db` | pass: 7 files, 71 tests |
| `pnpm test:e2e` | pass: 2 files, 41 tests |

Every acceptance criterion now has a passing test.

```
$ pnpm test
 Test Files  28 passed (28)
      Tests  700 passed (700)

$ pnpm lint
$ eslint src test

$ pnpm build
$ pnpm typecheck && nest build
$ tsc --noEmit -p tsconfig.json

$ pnpm test:db
$ vitest run --config ./vitest.config.db.ts
 Test Files  7 passed (7)
      Tests  71 passed (71)
   Start at  23:21:05
   Duration  11.07s

$ pnpm test:e2e
$ vitest run --config ./vitest.config.e2e.ts
 Test Files  2 passed (2)
      Tests  41 passed (41)
   Start at  23:21:16
   Duration  21.00s
```

The S0f db and e2e cases, from a verbose rerun of those files:

```
 ✓ test/db/marker-read.db-spec.ts > a marker read that raises on the server > keeps the SQLSTATE 22012 (division_by_zero) on the read and the identity
 ✓ test/db/marker-read.db-spec.ts > a marker that is not a string > database_identity(marker integer) holding 7: a failed read, UNKNOWN unreadable, no marker
 ✓ test/db/marker-read.db-spec.ts > a marker that is not a string > database_identity(marker text NULL) holding NULL: a failed read, UNKNOWN unreadable, no marker
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > a literal int8 beyond 2^53 comes back as the identical string
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > an int8 column holding it comes back as the identical string
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > control: through Drizzle a bigint-mode int8 is a JS bigint
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > control for the JSON ban: a jsonb number comes back as a JS number
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > numeric[] through the raw pool: JS numbers, not the stored strings
 ✓ test/db/round-trip.db-spec.ts > int8, jsonb and numeric[] through the raw pool (S0f) > numeric[] through Drizzle: the identical stored strings
 ✓ test/db/round-trip.db-spec.ts > server-filled timestamptz: microseconds against milliseconds (D12, S0f) > through Drizzle: = on the Date read from at6 misses, from at3 finds the row
 ✓ test/db/round-trip.db-spec.ts > server-filled timestamptz: microseconds against milliseconds (D12, S0f) > through the raw pool: the same
 ✓ test/db/round-trip.db-spec.ts > server-filled timestamptz: microseconds against milliseconds (D12, S0f) > 20 rows with at3 timestamptz(3) DEFAULT now() are each found again by =
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (e) a server error that holds the password: [REDACTED] in its place
 ✓ test/database-boot.e2e-spec.ts > a failed marker read after the connection opened (S0e round 2) > a connection reset during the read: UNKNOWN unreadable, and the boot carries on
 ✓ test/database-boot.e2e-spec.ts > a failed marker read after the connection opened (S0e round 2) > an ErrorResponse with SQLSTATE XX000: UNKNOWN unreadable with sqlstate, and no server text (S0f)
 ✓ test/database-boot.e2e-spec.ts > a failed marker read after the connection opened (S0e round 2) > a read that never answers: UNKNOWN unreadable within the read timeout
```

## First attempt: `make db-up` hung in the Docker credential helper

- My `make db-up` hung at `postgres Pulling`, with compose waiting on `docker-credential-desktop get`. I stopped there and did not work around it.
- The orchestrator found the cause: compose tries to pull even though the pinned image is already local. It started this worktree's Postgres with `docker compose --env-file /dev/null --file docker-compose.yml up --detach --wait --pull never`, then ran `make db-up`.
- The runs above use that container. Nothing was pulled.
- Possible follow-up for the Makefile: `--pull never` or `--pull missing` on `up`. Out of scope here; the Makefile is not this job's.

## What changed

**A. SQLSTATE** (`src/db/identity.ts`)
- `MarkerRead` `failed` gains an optional `sqlstate`, and so does `DatabaseIdentity` UNKNOWN.
- `markerReadFailure` keeps `code` only when it is a string matching `^[0-9A-Z]{5}$`. `42P01` is still `no_table`. A throwing `code` getter is a plain `failed`.
- `decideIdentity` copies `sqlstate` only on the `unreadable` return for a failed read. `identityLogFields` adds it.
- `identity.ts` still imports nothing, and `VERIFIED` is still returned from one place.
- `main.ts` needed no change: it already spreads `identityLogFields`.

**B. zod on the marker rows** (new `src/db/marker-rows.ts`; `src/db/client.ts`)
- `markerReadFromRows(rows: unknown)` parses with `z.array(z.object({ marker: z.string() }))`. Failure is `{ kind: 'failed' }` with no `sqlstate`. It never throws: `safeParse`, plus a catch for hostile getters.
- `client.ts` now does `const rows: unknown = (await client.query(query)).rows;` and has no type assertion on the rows.

**C. `util.inspect` gap** (`src/config/boot-output.ts`; `secrets.ts` unchanged)
- New `scrubbedForInspect(value, secrets)` builds a copy for `inspect`, with every recorded secret replaced in every string value it reaches:
  - all own properties, enumerable or not, so `message`, `stack`, `cause` and `errors` too
  - array elements, and Map and Set keys and values
  - boxed strings
- Prototypes are kept, so class names print the same. Errors are copied as real `Error`s re-prototyped, so `inspect` still prints them as errors. Cycles are kept.
- Getters are copied as descriptors and never called.
- Built-ins with internal slots (Date, RegExp, Buffer and typed arrays, Promise, Proxy, WeakMap, ...) pass through as they are.
- With no recorded secrets, or if copying fails, the original value comes back.
- `printBootFailure` inspects the copy, falling back to the original if `inspect` throws on it, and then still runs the text scrub.
- `BootConsoleLogger` overrides `stringifyMessage` (after `resolveMessage`) and `stringifyParams` in the same way. The existing `formatMessage` text scrub and `printStackTrace` stay.

**D. Schema scan** (`test/fixtures/schema-scan.ts`)
- The metadata layer is now an allow-list, exactly as in the spec table.
- `PgArray` recurses to its base column. Its rule names the array column, and the base type in the rule text.
- Each banned type has its own rule text. Any other type gives `column type <X> is not on the allow-list`.
- `KNOWN_COLUMN_TYPES` is exported, and a test builds every one from the installed drizzle-orm 0.45.4.
- Source layer:
  - flags `json(`, `jsonb(`, `bigserial(` with `mode: 'number'`, and `integer(`, `smallint(`, `serial(` and `smallserial(` on `*_ms`
  - flags `.array(` unless the root of its call chain is `text`, `varchar`, `char`, `uuid`, `boolean`, or a name assigned from `pgEnum(` in the same file
  - fails closed on a chain it cannot trace

**E. D12 precision** (same fixture)
- A `timestamptz` with any server default (`column.default !== undefined`) needs `precision` 0 to 3. `$defaultFn` is exempt.
- `SERVER_FILLED_EXEMPTIONS` holds exactly `database_identity.created_at`, with its reason.
- `scanTables(tables, exemptions = [])` reports an exemption that matches no violating column as `stale exemption`.

**F. Housekeeping**
- `tests.json`:
  - the `dependencies.spec.ts` text is fixed
  - three new entries: `marker-rows.spec.ts`, `boot-output.inspect.spec.ts` and `marker-read.db-spec.ts`
  - updated `covers` for `identity.spec`, `marker-read.spec`, `client.spec`, `schema-scan.spec`, `repo-files.spec`, `round-trip.db-spec` and `database-boot.e2e-spec`
- `progress.md`: an S0f Done line, and the "identity check" and "Column conventions" bullets.
- `src/db/schema.ts`: the conventions comment.
- `test/fixtures/fake-postgres.ts`: new `error-on-query` (ErrorResponse with a given SQLSTATE and message) and `row-on-query` (one DataRow of a given OID, or NULL) modes. They handle both the extended and the simple protocol.

## Acceptance criteria

| # | Suite | Proved by | Status |
|---|---|---|---|
| 1 | unit | `test/unit/db/identity.spec.ts` › "markerReadFailure keeps a well-formed SQLSTATE": the 4 codes, 12 no-sqlstate cases (uses `toStrictEqual` and `not.toHaveProperty`), 42P01 | pass |
| 2 | unit | same file › "has sqlstate exactly when code is a 5-character SQLSTATE other than 42P01" (fast-check, 2,000 runs) | pass |
| 3 | unit | identity.spec › "decideIdentity carries sqlstate on unreadable only" (3 cases + property over every MarkerRead shape, 2,000 runs) | pass |
| 4 | unit | identity.spec › identityLogFields "adds sqlstate when the identity has one…"; old case unchanged | pass |
| 5 | unit | `test/unit/db/marker-read.spec.ts` › "an ErrorResponse to the marker read (S0f)": XX000 kept, sentinel absent from read, identity and fields, 1 connection, 1 query, close resolves; the `X"0 0` code gives no sqlstate | pass |
| 6 | unit | marker-read.spec reset and silent cases, with an added `not.toHaveProperty('sqlstate')` | pass |
| 7 | db | `test/db/marker-read.db-spec.ts` › division_by_zero view → `{failed, sqlstate:'22012'}` | pass |
| 8 | e2e | `test/database-boot.e2e-spec.ts` › "an ErrorResponse with SQLSTATE XX000…"; reset and timeout cases now assert no `sqlstate` | pass |
| 9 | unit | `test/unit/db/marker-rows.spec.ts` › all listed shapes, plus a fast-check property over `fc.anything()` and row records (2,000 runs) | pass |
| 10 | unit | marker-read.spec › "a marker row that is not a string": int4 (OID 23) and NULL give failed, UNKNOWN unreadable, no marker; text (OID 25) control gives rows | pass |
| 11 | db | marker-read.db-spec › `marker integer` 7 and `marker text NULL` | pass |
| 12 | unit | identity.spec "imports nothing at all" unchanged; marker-rows.spec › "where the row check lives" | pass |
| 13 | unit | `test/unit/config/boot-output.inspect.spec.ts` › "prints no CORE…" (300 runs, 8 placements × 3 forms, more than 250 accepted URLs) | pass |
| 14 | unit | same › "control: with no recorded secrets…" (300 runs) | pass |
| 15 | unit | same › "the reviewer's probe", with control | pass |
| 16 | unit | same › "a long password that inspect splits at its newline", with control showing the two halves on separate lines | pass |
| 17 | unit | same › "BootConsoleLogger leaves no form of a secret" (60 runs, with control), plus a params case | pass |
| 18 | unit | same › "nothing else changes": exitCode, class name, `28P01`, a non-secret property, `[Circular`, identical inspect with no secret, getters not called. The existing boot-output, secrets, secrets.property, logging and app-logger specs are unchanged and pass | pass |
| 19 | e2e | existing database-boot (e) unchanged | pass |
| 20 | unit | schema-scan.spec real-schema tests | pass |
| 21 | unit | schema-scan.spec › "the scanner: S0f bans" (13 forms, metadata and source layers) | pass |
| 22 | unit | schema-scan.spec › date (`PgDateString`), date mode (`PgDate`), interval, point (`PgPointTuple`) | pass |
| 23 | unit | schema-scan.spec › "fails closed on a columnType it has never seen" (stubs a column and an array's base column) | pass |
| 24 | unit | schema-scan.spec › "the scanner: S0f allows" plus the old allowed test | pass |
| 25 | db | `test/db/round-trip.db-spec.ts` › "int8, jsonb and numeric[] through the raw pool (S0f)" | pass (round 1b) |
| 26 | unit | `test/unit/db/client.spec.ts` › "the global type parsers after importing src/db/client.ts"; the `setTypeParser` ban in drizzle.spec is unchanged | pass |
| 27 | unit | schema-scan.spec › "server-filled timestamptz precision" failing cases (plus string mode) | pass |
| 28 | unit | same › "passes precision 3 or 0 with defaultNow(), no default, and $defaultFn" | pass |
| 29 | unit | schema-scan.spec › "the server-filled exemption list" (pinned list, fails without the exemption, stale entry) | pass |
| 30 | db | round-trip.db-spec › "through Drizzle…" and "through the raw pool: the same" | pass |
| 31 | db | round-trip.db-spec › "20 rows with at3 timestamptz(3) DEFAULT now()…" | pass |
| 32 | unit | `test/unit/tooling/repo-files.spec.ts` › "describes dependencies.spec.ts with verifyDepsBeforeRun" | pass |
| 33 | unit | repo-files.spec tests.json checks (unchanged) | pass |
| 34 | unit | repo-files.spec Current state names `sqlstate`, `jsonb` and `precision`; marks S0f done | pass |
| 35 | unit | `pnpm lint`, typecheck (in `pnpm build`) and `pnpm test` pass; the lockfile and `package.json` are untouched | pass |

**Criterion 25, numeric[]: the observed result** (round 1b). The value `'{1.10,-0.00000001}'` came back as:
- **Raw pool:** `[1.1, -1e-8]`, both of `typeof` `'number'`. pg-types parses OID 1231 with `parseFloatArray`, so money in a `numeric[]` read through the raw pool becomes a JS number. This is the reason for the ban.
- **Drizzle:** `['1.10', '-0.00000001']`, the identical stored strings. Drizzle's node-postgres session (`drizzle-orm/node-postgres/session.js`, the `typeId === 1231` branch) replaces that parser on its own queries.

My first build predicted `['1.1', '-1e-8']` for Drizzle without seeing that branch, and the real run failed that assertion. The test is now named "numeric[] through Drizzle: the identical stored strings" and asserts what was observed. The ban stays: the same column through the raw pool loses the strings, and the scan cannot tell which path a later job will read with.

## Existing tests changed (the spec allows this when the scan or the result is stricter)

- `identity.spec.ts`, "markerReadFailure › reads %s as a failed read": the `42501` and `42703` rows asserted `{ kind: 'failed' }`. They now assert `{ kind: 'failed', sqlstate: '42501' / '42703' }`, as criterion 1 requires. The table gained a third column and uses `toStrictEqual`.
- `schema-scan.spec.ts`, "has no banned column in the table metadata": it now calls `scanTables(tables, SERVER_FILLED_EXEMPTIONS)`, because the new precision rule rejects `created_at` without its pinned exemption (criterion 29).
- `marker-read.spec.ts`, the reset and silent cases: only gained `not.toHaveProperty('sqlstate')`.
- `database-boot.e2e-spec.ts`, `expectUnreadableBoot`: gained an optional `sqlstate` parameter. With none, it asserts the property is absent.

No test was deleted, skipped or loosened.

## For the reviewer

1. **The `scrubbedForInspect` copy** (`src/config/boot-output.ts`) is the security-relevant change. Check:
   - **Error copies.** A real `Error` is created, re-prototyped, has its own `stack` deleted, and then gets the original's own descriptors. `stack` is read once through V8's accessor and redefined as a data property.
   - **The pass-through list.** A Proxy passes through un-scrubbed, as `inspect` would read it. A string inside one is then left to the text scrub, which is the old behaviour.
   - **The fallbacks.** If copying or inspecting the copy throws, the original is inspected and text-scrubbed. That is never worse than before.
   - **Depth.** The copy stops at depth 16, deeper than either printer prints.
   - **Property names and Symbol keys** are not scrubbed, per Out.
2. **The precision rule is a little stricter than the spec.** It applies to any server default (`.default(<any value>)`), not only an SQL expression, because a literal string default can carry µs too. A stale exemption is also any entry that exempts nothing, including a column that already complies, not only a missing column.
3. **Allow-list edges that fail closed:**
   - `PgEnumObjectColumn`, a `pgEnum` built from a TS enum object, is not in the spec table, so it fails.
   - In the source layer, an `.array()` on a namespaced builder (`pg.text('x').array()`) fails.
4. **The `sqlstate` regex** is anchored with `^…$` and no `m` flag. In JS, `$` then does not match before a trailing `\n`. A test covers `'XX000\n'`.
5. **The fake server** answers on the first data chunk after startup. For the extended protocol it sends ParseComplete, BindComplete, RowDescription, DataRow, CommandComplete and ReadyForQuery. pg accepted this in every unit run.

## Open decisions for the human (from the spec, all taken at their defaults)

1. Allow-list scan, with the integer family for counts and ids.
2. `json`/`jsonb` banned.
3. Arrays only of text-like, `uuid`, `boolean` and enum elements.
4. `database_identity.created_at` gets a pinned exemption, not a migration.
5. The field is named `sqlstate` and validated by `^[0-9A-Z]{5}$`.

The job touches `src/config/boot-output.ts`, so it needs human sign-off.

## Round 1b: the coordinator's correction

The orchestrator ran `pnpm test:db` at `5198610`. 70 of 71 passed; the one failure was my Drizzle `numeric[]` prediction (`expected [ '1.10', '-0.00000001' ] to deeply equal [ '1.1', '-1e-8' ]`). Fixes:
- `test/db/round-trip.db-spec.ts`: the Drizzle case is renamed and asserts the observed identical strings. The raw-pool case and its comment now carry the reason for the ban.
- `tests.json` (round-trip `covers`) and `progress.md` ("Column conventions", Arrays bullet): the prediction text is replaced with the observed behaviour.
- All five commands rerun against the running compose container. Output is under Status above.
- The fix is commit `6e43a8c`. After it, `docker compose --env-file /dev/null --file docker-compose.yml down --volumes` from the worktree root removed this project's container, network and `pgdata` volume, and nothing else.
