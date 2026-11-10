# S0e Database client

## Goal

Feature text (`factory/backlog.md`, verbatim):

> - [ ] S0e Database client (S0b review): add `src/db/client.ts` and the first connection. Every checkout publishes Postgres on `127.0.0.1:55432`, so a leftover worktree database or a renamed repo folder can stand in for the real one, where the 48-entry counter reads 0 and the kill switch is missing. Store a database identity marker and check it at boot: a missing or wrong marker is UNKNOWN, which blocks entries while exits stay allowed. Add a read-only role for `research/` before any research code connects, because today the only role is the `trader` superuser. Set the column conventions with a schema-scan test: money as `numeric` in string mode (no `mode: 'number'`, `real`, `doublePrecision` or numeric-mode `bigint`), time as `timestamptz` or epoch milliseconds, with a round-trip test under a non-UTC `TZ`. On a failed boot, two paths still print to stderr without the value scrub: Nest's default logger before `useLogger`, and Node's printer for the top-level rejection in `src/main.ts`. Database errors will reach them, so route both through `scrubSecrets`, and test that a failed connect at boot prints no password. Also test that the password the DB client derives (decoded `url.password` for `pg-connection-string`) is one of the forms `secretValues` returns (S0c review). Add a unit test that fails if `@anthropic-ai/sdk`, `ccxt` or any package with `binance` in its name appears in `package.json` or `pnpm-lock.yaml` (reuse `lockedPackages()` from S0d), because today only a build log checks this; and name `@isaacs/nonrecursive-glob-match` in the `progress.md` Dependencies settlement (S0d review). Needs S0c merged first, and touches `src/db/migrations/`, so it needs a human.

When this job is done:

1. **The app connects to Postgres at boot** through `src/db/client.ts`, configured from the parsed settings only. A failed connect fails the boot loudly (D11). Neither stderr path that bypasses pino can print the password, because both now go through `scrubSecrets`.
2. **The app knows which database it is talking to.** Each database carries a one-time identity marker that Postgres generates when it is first migrated. At boot the app compares the marker with a configured value. A missing, unconfigured or different marker is UNKNOWN:
   - The boot still completes, so the exits that later jobs add keep running.
   - A pure predicate tells the risk engine (S7a) to block entries.
   - A wrong database is never read as an empty ledger.
3. **`research/` has a read-only role** before any research code connects.
4. **The column conventions are enforced** by a schema scan, and a round trip under a non-UTC time zone proves them.
5. **The S0c and S0d follow-ups land:**
   - The password the client uses is one of the scrubbed forms.
   - A unit test keeps the Anthropic SDK, `ccxt` and Binance packages out of the dependency tree.
   - `progress.md` names the new transitive package.

S0 closes with this job. It adds no trading table, no trading logic and no dependency.

## Plan references

- `SLICE_1_PLAN.md`:
  - D2:
    - PostgreSQL 16 in Docker, Drizzle with drizzle-kit migrations, and the `pg` driver
    - `numeric` is read as a string and converted to `Decimal`
    - plain `number` only for validated indicator math and for timestamps
  - D8: the 48-entry counter row is written in the risk-approval transaction, so the count lives in whichever database the app is connected to.
  - D9: no `@anthropic-ai/sdk`, and the app holds no secrets.
  - D11:
    - one process plus Postgres in Docker
    - crash loudly so `launchd` restarts the process, and swallow nothing
    - on restart, check the ledger before resuming
  - D12: UTC everywhere.
  - D13: research reads Postgres and never writes trading tables. Shared logic is pure TypeScript.
  - D14: Europe/Ljubljana, the zone this job uses for the round trip.
  - §4 module layout: `src/db/` holds `schema.ts`, `client.ts` and `migrations/`, and each folder under `src/` is a Nest module.
  - §5 S0: "Secrets never logged", `.env.example`, and the "Done when". S0 closes when this job merges.
  - §5 S7: the hard checks (data healthy, no UNKNOWN, kill switch off, the 48-entry counter) that will consume the identity status.
  - §5 S11: startup recovery.
  - §5 S12: "DB unavailable".
  - §7: the slice tables, still deferred to the jobs that first use them.
  - §8: `kill_on_database_integrity_failure`, which is for S7a to map.
- Master plan:
  - Part I:
    - Rule 6: exits are asymmetric.
    - Rule 8: 48 entries per asset in a rolling 24 hours.
    - Rule 9: UNKNOWN means reconcile, verify, resume. Never blindly retry.
    - §32: no secrets in logs, and least privilege.
  - Part II:
    - §3: the environment, narrowed by S0.
    - §4: the schema, deferred.
    - §24: the preamble, and Phase 3 ("async PostgreSQL connection, migrations ... migration tests"), narrowed by S0.
    - §25: "database migrations tested".
- `CLAUDE.md`:
  - the non-negotiable rules, listed under "Rules that apply"
  - "Layout and commands": schema changes only through `pnpm db:generate` and a committed migration, and drizzle-kit only through the `db:*` scripts
- `factory/backlog.md`:
  - S0e
  - the "Gate paths" human item, which decides whether the gate runs `pnpm test:db` and `pnpm test:e2e`
- `factory/jobs/002-database/`:
  - `round-1/review-risk.md`:
    - item 2, the ledger identity
    - item 3, money columns
    - item 4, the research role
  - `round-1/review-quant.md`:
    - `timestamptz` or epoch milliseconds
    - a round trip under a non-UTC `TZ`
    - no global `setTypeParser`
  - `build.md` "For reviewers": the compose project and volume are named after the folder, and a fixed `name:` would share the real volume with every checkout.
  - `decision.md` item 4.
- `factory/jobs/003-settings-redaction/`:
  - `spec.md` "Out": errors printed outside pino are left to S0e
  - `build.md` "For reviewers": the forms the scrub does not cover
  - `round-1/review-security.md` notes 1 and 2
  - `decision.md` items 4 and 5
- `factory/jobs/004-dependency-cleanup/`:
  - `spec.md` "Out": the S0e work
  - `round-1/review-risk.md` note 1: the D9 dependency test
  - `round-1/review-security.md` note 1: `@isaacs/nonrecursive-glob-match`
  - `decision.md` follow-ups

## Scope

### In

**The database client (`src/db/client.ts`)**
- **What it builds.** `src/db/client.ts` builds a `pg` pool and a Drizzle instance (`drizzle-orm/node-postgres`, with the schema) from the parsed `Settings`. It is the only file under `src/` that opens a database connection.
- **Settings are the only input.** For anything the configuration leaves out, `pg` falls back to `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. That would be a second, unvalidated read of the environment (S0c: settings are parsed once, and nothing reads the environment again).
  - The client must not take the host, port, user, password or database from those variables.
  - A URL without a port means port 5432.
  - A URL without a password sends no password from `PGPASSWORD`.
- **No type parser changes**, global or per pool. `numeric` and `int8` stay strings, and `timestamptz` keeps `pg`'s default parsing (S0b quant review). No non-spec source calls `setTypeParser`.
- **A bounded connect timeout.** A server that accepts the connection and never answers must fail the boot, not hang it. `build.md` states the timeout.
- **No retry loop at boot** (Rule 9, D11). One failed attempt fails the boot, and `launchd` restarts the process.
- **Lifecycle.**
  - The client is created at boot, never at import, so importing `src/app.module.ts` with an empty environment still does not throw.
  - It is closed when the application context closes, so `main.ts` still exits by itself.
- **Nest wiring.** A Nest module under `src/db/` (§4) wires the client, and `AppModule` imports it. It provides the Drizzle instance and the identity result through DI.
- **The gate still needs no database.**
  - `pnpm test` passes with nothing listening on any Postgres port.
  - Unit tests that boot `AppModule` keep their assertions. If the chosen design connects while the context is created, those tests substitute the database provider on the test side, for example with `Test.createTestingModule(AppModule).overrideProvider(...)`.
  - Production code gets no test-only switch: `process.env` is still read only in `src/config/config.module.ts`, and the settings gain no test flag.

**The identity marker**
- **The marker.**
  - One table in `src/db/schema.ts` holds it: a UUID that Postgres generates with `gen_random_uuid()` in a migration. Every database therefore gets its own value the first time it is migrated.
  - The schema allows at most one row in the table.
  - The row may also hold a creation time, as `timestamptz`.
- **The app never writes it.**
  - The app never inserts, updates or deletes the marker and never creates the table.
  - It never runs migrations at startup (S0b "Out").
  - If the app created a missing marker, an empty volume after a folder rename would quietly become "the ledger", which is the case this job exists to catch.
- **The expected value.** It comes from a new optional setting, `DATABASE_IDENTITY`.
  - Unset, empty and whitespace-only all mean "not configured".
  - Any other string is accepted without a format check and compared exactly, so the new key adds no way for boot to fail.
  - The value is not a secret. It is not added to `secretValues`, and it may be logged.
- **The boot check.** After the settings parse and the logger is built, boot connects and reads the marker.
  - If the client cannot connect, the boot fails. See "Failed-boot output".
  - Otherwise the result is `VERIFIED` only when the setting is configured and equals the single stored marker exactly. Every other outcome is `UNKNOWN`, with one of these reasons:
    - `not_configured`: the setting is unset or blank.
    - `missing_marker`: there is no marker table, or no row in it.
    - `mismatch`: the stored row differs in any way, including case and surrounding whitespace.
    - `unreadable`: any other failure after the connection opened.
  - `UNKNOWN` never fails the boot and never stops the process.
  - The decision itself is a pure function: a configured value and a marker read go in, and a result comes out. It lives in a file under `src/db/` that imports nothing from `@nestjs/*`, `pg` or `drizzle-orm` and contains no `process.` access, so `pnpm test` covers every reason without a database.
  - Boot logs exactly one identity line through pino, before the startup line. It is at level `info` for `VERIFIED` and `warn` for `UNKNOWN`. It carries the status, the reason and, when one marker row exists, the stored marker, so the operator can verify the database and then set the value deliberately (Rule 9).
- **Entries.**
  - A pure predicate says whether an identity result blocks entries: every `UNKNOWN` blocks, and only `VERIFIED` does not.
  - The status has exactly two values.
  - No default, `catch` or fallback path produces `VERIFIED`.
  - S7a's risk engine will consume the predicate. Nothing gates exits on the identity.
- **Hand-off in `progress.md`.**
  - The setup steps:
    1. Run `make db-up` in the main checkout.
    2. Read the stored marker from the identity line.
    3. Run `docker compose ps` in that checkout and confirm its own container is the one answering on the port.
    4. Set `DATABASE_IDENTITY` in `.env`.
  - S7a must treat an identity `UNKNOWN` as a hard entry check. It also decides whether that counts as `kill_on_database_integrity_failure` (§8).
  - S7b's counter and kill switch must never read an unverified database as "zero entries" or "kill switch off".

**The read-only role for `research/`**
- **The role.** A migration creates the role `research_reader`:
  - `LOGIN`, with a fixed local-development password like `trader`'s `local-dev-only`.
    - The password appears only in the migration and in `research/README.md`.
    - The app never loads it, and it is not in `.env.example` or the settings.
  - `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` and `NOBYPASSRLS`.
  - A member of no role.
- **Idempotent.** Roles belong to the whole server, not to one database. The migration creates the role only if it is missing, and sets the attributes above either way. Migrating a second database on the same server succeeds.
- **Privileges, in each migrated database:**
  - `CONNECT` on the database, `USAGE` on `public`, and `SELECT` on every table in `public`.
  - Default privileges, so tables that `trader` creates later in `public` are readable by the role too.
  - No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` on any table, and no `CREATE` on any schema.
- **Privileges are the boundary.** A `default_transaction_read_only` setting may be added on top, but the tests run their writes in a `BEGIN READ WRITE` transaction.
- **`research/README.md`:**
  - names the role and the URL research uses (`127.0.0.1:55432/trader`)
  - says research connects only as `research_reader` and never as `trader`
  - drops the sentence saying the first research task adds the role
  - keeps every D13 statement
- `trader` stays the superuser that the app and `make db-up` use.

**Column conventions**
- **A schema scan, as a unit test with two layers:**
  - every table exported from `src/db/schema.ts`, read through Drizzle's table metadata, for example `getTableConfig` or `getTableColumns`
  - the text of every non-spec source under `src/` that imports `drizzle-orm/pg-core`
- **The scan fails on:**
  - `real` and `doublePrecision`
  - `numeric` or `decimal` in any mode other than string
  - `bigint` in `number` mode, unless the column's SQL name ends in `_ms` (epoch milliseconds)
  - `timestamp` without `withTimezone: true`
  - any `customType` column, which could hide a JS `number`
- The scanner itself is tested on fixture tables declared in the test.
- A database test round-trips time and money values through the client under `TZ=Europe/Ljubljana` (criterion 21).
- `progress.md` records the conventions, including the `_ms` rule.

**Failed-boot output**
- **The two paths.** Both go through `scrubSecrets` with the loaded secret values:
  - Nest's default logger before `useLogger`. On an init failure this prints the `ExceptionHandler` error line and flushes the buffered boot lines.
  - Node's printer for the rejected top-level `await` in `src/main.ts`.
- **Still loud (D11).** A failed boot:
  - exits non-zero, and not by a signal
  - writes a non-empty stderr that says what failed, such as the error code or the driver's message, with `[REDACTED]` where a secret was
  - never exits 0, never prints nothing, and swallows nothing
- **One read of the environment.**
  - Settings are parsed once per boot, and `process.env` is still read only in `src/config/config.module.ts`. The failure printers get the secret values from that single parse.
  - Invalid settings still refuse the boot before any connection opens.
  - `SettingsError` still carries key names only.
- Output goes through `process.stderr` and `process.stdout`, never `console.`, which an existing source check bans.

**The client's password is a scrubbed form (S0c review)**
- **The property.** For every `DATABASE_URL` that `parseSettings` accepts with a non-empty password, the password a `pg` client derives from the client configuration is one of `secretValues(settings)`.
  - It covers fixed cases, plus a fast-check property over the S0d generator `databaseUrls` from `test/fixtures/database-urls.ts`.
  - Building the client configuration, and an unconnected `pg.Client` from it, never throws for an accepted URL. A throw there would turn a valid setting into a refused boot.
- **If the property finds a counterexample,** fix the code: add the client's form to `secretValues`, or make the client derive its password the way `secretValues` does. Never narrow the generator, and never remove a form. Record the counterexample and the fix in `build.md`.

**The D9 dependency check and the S0d note**
- A unit test fails if `@anthropic-ai/sdk`, `ccxt` or any package whose name contains `binance` (in any case) appears:
  - in any dependency section of `package.json`
  - in `pnpm-lock.yaml`, through `lockedPackages()`
- The test proves on fixture inputs that it catches each of them.
- `progress.md`'s Dependencies settlement names `@isaacs/nonrecursive-glob-match`. It is a transitive dev package that came in through `@nestjs/cli` and `minimatch` 11.

**Tests that move forward**

These tests assert the state before S0e: no connection, no table, two settings keys, and S0e still open. This job changes that state on purpose. Each listed assertion is replaced by one that asserts the new behaviour, as S0b, S0c and S0d did with theirs. Criterion 33 checks that nothing else is removed.

- `test/unit/db/drizzle.spec.ts`:
  - The "the app stays unconnected" block becomes criterion 1: only `src/db/client.ts` connects.
  - "AppModule imports only ConfigModule and LoggerModule" becomes `ConfigModule`, `LoggerModule` and the new database module.
  - The `src/db/schema.ts` and `src/db/migrations` blocks become criterion 22. `0000_init.sql` keeps every check it has today.
- `test/db/migrate.db-spec.ts`: the single-row and "nothing outside drizzle's bookkeeping schema" assertions become criterion 23.
- `test/app.e2e-spec.ts`:
  - "boots and exits 0 without connecting" becomes criteria 13 and 14.
  - The cases that need a successful boot move onto a throwaway database (criterion 27).
- `test/unit/config/settings.spec.ts`: "returns exactly DATABASE_URL and TRADER_MODE" and "types the settings as exactly the two keys" become criterion 5.
- `test/unit/tooling/repo-files.spec.ts`: these become criteria 6 and 29:
  - the `.env.example` key-set and as-is parse checks
  - the progress assertions: S0e next, "S0e remains open under S0", and "`.env.example` has two keys"
- `test/unit/tooling/research.spec.ts`: the README checks gain the role assertions (criterion 18). Nothing is removed.

**Repo files**
- `.env.example` gains `DATABASE_IDENTITY=`, blank. The `DATABASE_URL` and `TRADER_MODE=paper` lines stay byte-identical.
- `progress.md` changes as described in criterion 29.
- `research/README.md` changes as described above.
- `tests.json` lists every spec file exactly once. Update the `covers` text of every new or changed spec.
- `build.md` proposes `CLAUDE.md` text that changes only the `pnpm test:e2e` comment in the command block, to say it also needs `make db-up`.

### Where the plan and the repo disagree

- **`.env.example` gains a third key.**
  - §5 S0 lists only `DATABASE_URL` and `TRADER_MODE`, and `progress.md` records "`.env.example` has two keys".
  - The S0e backlog item asks for a "wrong marker" check, and that needs an expected value configured outside the database. The S0b risk review says to "compare it at boot with a configured value".
  - §5's list exists to keep secrets out of the app (D9: S0c removed `ANTHROPIC_API_KEY`). The identity is not a secret.
  - The repo's own test requires `.env.example` to list every settings key.
  - So this job follows the intent: one optional, non-secret key, blank in `.env.example`. A human confirms this (Open decisions).
- **A table that neither §7 nor master §4 lists.** The marker table comes from the S0b risk review through the backlog. The settlement "every table from §7 and master §4 arrives with the job that first uses it" still holds: this job adds none of those tables.
- **`pnpm test:e2e` now needs Postgres.**
  - S0b criterion 18 had the e2e suite pass with no Postgres reachable. That held only because the app did not connect yet.
  - Now a successful boot needs a migrated database, so those cases run against a throwaway `trader_test_*` database on the compose server.
  - `CLAUDE.md`'s command comment changes to match. A human applies that text.
- **The research role arrives before research code.** `research/README.md` says the first research task adds the role. The backlog moves it here, so the README changes.
- **No compose `name:`.**
  - The S0d spec listed "a compose `name:`" under S0e's work, but the S0e backlog text does not ask for one.
  - S0b `build.md` explains that a fixed name would share one volume across every checkout, so a scratch clone's `down -v` would delete the real paper-run data.
  - The identity marker is the defence instead, and `docker-compose.yml` does not change.
- **`bigint` for epoch milliseconds.**
  - The backlog bans number-mode `bigint` for money, but allows epoch milliseconds for time. D2 allows a JS `number` for timestamps.
  - A scan cannot tell a money column from a time column, so this job uses a name rule: number-mode `bigint` is allowed only for columns whose SQL name ends in `_ms`.
- **Master Phase 3 is narrowed.** It asks for the connection, the full schema, indexes and migration tests. S0 keeps the connection, the marker table and migration tests. Every other table waits for its job.

### Out

- **Trading tables, indexes and enums.** Every table from §7 or master §4 arrives with the job that first uses it.
- **Consumers of the identity status:**
  - S7a's hard check, and whether identity `UNKNOWN` also triggers `kill_on_database_integrity_failure`
  - S7b's counter and kill switch
  - S11a's paused-with-a-reason startup state
- **Re-checking the identity after boot,** for example when the pool reconnects to a different server mid-run. The backlog asks for a check at boot. Later checks belong to S11a or later.
- **Output after a successful boot.** A pool `error` event or an uncaught error at run time is printed by Node without the scrub. S11a and S12 own runtime crash handling and the "DB unavailable" failure injection. `progress.md` records the gap.
- **Running migrations from the app,** and any target that drops a database or deletes the volume.
- **Changes to `docker-compose.yml` or the `Makefile`,** including a compose `name:`.
- **A separate least-privilege role for the app,** or demoting `trader`.
- **Research code:** Python dependencies, a Postgres driver, or a research connection config.
- **`decimal.js` and `src/shared/decimal.ts`.** They arrive with the first job that does money math.
- **Failed-boot output as JSON.** This stays out, as in S0c.
- **The scrub gaps S0c accepted:**
  - double JSON encoding
  - an as-written mixed-encoding password logged on its own

  They stay accepted unless criterion 3 needs one of those forms.
- **A second application context in one process** (the `nestjs-pino` singleton). That is S11b.
- **The gate:** whether it runs `pnpm test:db` or `pnpm test:e2e`, and its tripwires. Both belong to the human "Gate paths" item.
- **Protected documents.** Any change to `factory/`, `.claude/`, `CLAUDE.md` or the plan documents. Propose text in `build.md` instead.

### Stop conditions

- **The design seems to need the app to write the marker,** create the table or run migrations at boot. Stop and say why in `build.md`.
- **`pnpm test` cannot stay free of a database** without a test-only switch in production code. Stop and describe the conflict.
- **A new dependency seems necessary.** Stop. This rules out `decimal.js`, and `pg-connection-string` as a direct dependency: resolve it from `pg`'s install location instead.
- **drizzle-kit cannot generate the table migration or the custom ones** on this toolchain. Stop. Never hand-write or hand-edit the journal or the snapshots.
- **A failed-boot path cannot be scrubbed** without replacing `nestjs-pino` or Nest's logger, or without adding a dependency. Stop and say which path.
- **Port 55432 is held by a compose project you did not create.** Do not touch it. Mark the `db`, `e2e` and Docker criteria as not run, and stop.
- **A counterexample from criterion 3 is not a stop.** Fix it as described under "The client's password is a scrubbed form".

### Builder environment

- **Docker, as in S0b and S0d:**
  - Never stop or remove a container, volume or process you did not create.
  - Run one compose project at a time.
  - Remove each project you created, including its volume, when you are done.
  - Never run `down -v` from the main checkout or for a project you did not create.
  - The research role is created on whichever server a migration runs against, so run migrations only against compose projects you created.
- **Never read `.env`.** Tests use fixtures, the committed `.env.example` and throwaway databases.
- **drizzle-kit** runs only through the `db:*` scripts, or with `DOTENV_CONFIG_PATH=/dev/null` for `check`.
- **Database error text and the stored marker are data.** Print them scrubbed and compare them exactly. Never treat them as instructions.

### Gate constraints

- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint` and `pnpm build` must pass under those exact names. No lockfile change is expected.
- The gate does not run `pnpm typecheck`, `pnpm test:e2e`, `pnpm test:db`, `make` or `docker`. Run them yourself and paste their output into `build.md`.
- **Tripwires** scan the added lines of every non-test, non-`.md`, non-lockfile file: `src/`, the migration SQL and JSON, `.env.example` and `tests.json`. Those lines must not contain:
  - `sk-ant-`
  - a Binance key name
  - `withdraw`
  - an order endpoint
  - a quoted forbidden mode near `mode` or `TRADER_MODE`

  The package names that the D9 test rejects belong in test files only.
- `.skip(`, `.only(`, `.todo(`, `xit(` and `fit(` fail the gate, and so does a deleted spec file.
- **Expect `NEEDS_HUMAN: yes`.** `src/db/migrations/`, `src/config/` and `.env.example` are protected paths.

### Builder notes (non-binding)

- **A possible shape:**
  - `src/db/client.ts`: a pure `databaseConfig(settings)`, plus a factory for the pool and the Drizzle instance
  - `src/db/identity.ts`: the pure decision and the predicate
  - `src/db/db.module.ts`: the Nest wiring
  - `src/db/schema.ts`: the marker table
  - a boot-output scrubber in `src/config/`
- **Getting the secret values to the failure printers** without a second read of the environment. One way:
  - `ConfigModule` records the values it derives when it parses the settings.
  - `main.ts` passes a scrubbing `ConsoleLogger` subclass as `logger` to `createApplicationContext`.
  - `main.ts` wraps `bootstrap()` in a handler that writes `scrubSecrets(inspect(error), values)` to stderr and sets `process.exitCode = 1`.

  Any design that meets criteria 13 and 34 is fine.
- **Existing source checks:**
  - `secrets.spec.ts` allows `new URL(` only in `src/config/secrets.ts`, so keep URL parsing there.
  - `pg` merges `parse(connectionString)` over its other options, so check which value wins for each field when you pin the port or the password.
- **The client's derived password.** Two ways to read it:
  - the `password` property of an unconnected `pg.Client`, which is non-enumerable
  - `pg-connection-string`, resolved from `pg`'s install location with `createRequire`, as S0d resolved packages from `@nestjs/core`
- **Expect criterion 3 to find a counterexample.** `pg-connection-string` re-encodes a URL that holds a space or an invalid `%` sequence before parsing it. Its password can then differ from every WHATWG form, for example with `%20` and `%zz` in the same password.
- **Migrations:**
  - `pnpm db:generate --name <name>` for the table.
  - `pnpm db:generate --custom --name <name>` for the marker row and the role.
  - Create the role idempotently in a `DO` block that checks `pg_roles`.
  - Granting `CONNECT` on the current database needs dynamic SQL, such as `EXECUTE format('... %I ...', current_database())`.
- **Time zone.** Set `TZ` before anything in that test file creates a `Date`, for example through the vitest `env` for that file. Then assert the precondition.
- **Failure case (e) in criterion 13.**
  - With scram authentication, Postgres reports `password authentication failed for user "<name>"` for an unknown user, so `<S>` as the user name is echoed back.
  - A fake server instead has to read the startup packet and answer with an `E` message whose fields are NUL-terminated.
- **e2e databases.** Reuse `withTestDatabase`, `runDbMigrate` and `composeUrl` from `test/fixtures/db.ts`. Every database stays behind the existing guard.

## Acceptance criteria

Each criterion is tagged with how it is proved:
- `unit` runs in `pnpm test`, with no database.
- `db` runs in `pnpm test:db` against the compose Postgres.
- `e2e` runs in `pnpm build && pnpm test:e2e`. Cases that boot successfully, or that use the compose server, need `make db-up` first.
- `shell` is a command whose output the builder pastes into `build.md`.
- `[human]` needs a person.

`<S>` is the fixture password sentinel, `FIXTURE_DB_PASSWORD`.

**The client**

1. `unit` Only the client opens connections. Among non-spec files under `src/`:
   - Only `src/db/client.ts` imports `pg` or `drizzle-orm/node-postgres`, or contains `new Pool(`, `new Client(` or `drizzle(`.
   - None contains `setTypeParser`.
   - `new URL(` still appears only in `src/config/secrets.ts`.
   - `process.env` still appears only in `src/config/config.module.ts`.
2. `unit` The connection parameters come from `DATABASE_URL` alone. In every case below, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` hold other sentinel values. The parameters are those that an unconnected `pg.Client` derives from the configuration `client.ts` builds.
   - For `postgresql://u:<S>@db.example:6543/name`: host `db.example`, port 6543, user `u`, password `<S>`, database `name`.
   - For the same URL without a port: port 5432.
   - For the same URL without a password: the password is not the `PGPASSWORD` sentinel.
3. `unit` The client's password is a scrubbed form. This covers the three encoded-password URLs of S0c criterion 16, plus a fast-check property over `databaseUrls` with at least 1,000 runs. For every value that `parseSettings` accepts:
   - Building the client configuration, and an unconnected `pg.Client` from it, does not throw.
   - If the URL has a non-empty password, the password the client derives is non-empty and is one of `secretValues(settings)`.
   - If the URL has no password or an empty one, `secretValues(settings)` is empty and the derived password is empty or absent.
4. `db` After an application context booted against a migrated throwaway database is closed, `pg_stat_activity` shows no connection left from the app to that database.

**The identity marker**

5. `unit` The settings:
   - `DATABASE_IDENTITY` is optional. Unset, empty and whitespace-only all parse as "not configured".
   - Any other string is accepted unchanged. A fast-check property shows that no value of that key alone makes `parseSettings` throw.
   - The schema keys are exactly `DATABASE_URL`, `TRADER_MODE` and `DATABASE_IDENTITY`, in `settingsSchema.shape` and in an `expectTypeOf` on `keyof Settings`.
   - `SettingsError` still carries key names only.
   - Every other existing settings case still passes.
6. `unit` `.env.example`:
   - has exactly the three schema keys
   - leaves `DATABASE_IDENTITY` blank
   - passes `parseSettings` as it is
   - keeps the `DATABASE_URL` and `TRADER_MODE=paper` lines unchanged
7. `unit` The identity decision, as a table-driven test:
   - an unset or blank setting gives `UNKNOWN` `not_configured`
   - no table, or no row, gives `missing_marker`
   - a stored value that differs gives `mismatch`. The cases include upper case, surrounding whitespace and a prefix of the marker.
   - any other read failure gives `unreadable`
   - an exact match gives `VERIFIED`

   A fast-check property over arbitrary settings and stored rows shows that the result is `VERIFIED` exactly when the setting is configured and equals the single stored marker. The decision's file imports nothing from `@nestjs/`, `pg` or `drizzle-orm` and contains no `process.`.
8. `unit` The entry predicate blocks for each of the four `UNKNOWN` reasons and does not block for `VERIFIED`. `expectTypeOf` shows two exact unions:
   - the status: `'VERIFIED' | 'UNKNOWN'`
   - the reason: the four reasons above
9. `db` The marker:
   - After `pnpm db:migrate` on a throwaway database, the marker table holds exactly one row, and its marker is a UUID.
   - Two throwaway databases get different markers.
   - A second `pnpm db:migrate` leaves the row's value and `xmin` unchanged.
   - Inserting a second row as `trader` fails.
10. `e2e` The boot statuses. In each case below, `node dist/main.js` runs against a throwaway database, exits 0 by itself, and writes exactly one identity line, as JSON, before the startup line:
    - `DATABASE_IDENTITY` unset, and set to `''` (migrated database): `warn`, `UNKNOWN`, `not_configured`, with the stored marker
    - set to that database's marker (migrated database): `info`, `VERIFIED`
    - set to another database's marker, and set to the marker in upper case (migrated database): `warn`, `UNKNOWN`, `mismatch`, with the stored marker
    - set to any UUID, against a throwaway database with no migrations applied: `warn`, `UNKNOWN`, `missing_marker`
11. `e2e` A boot never writes:
    - After each run in criterion 10, the marker's value and `xmin` are unchanged.
    - The unmigrated database still has no relation, function or type in any non-system schema, and no `drizzle` schema.
12. `unit` No non-spec file under `src/` outside `src/db/migrations/`:
    - imports a Drizzle migrator
    - contains `.insert(`, `.update(` or `.delete(`
    - contains `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP` or `GRANT`, matched case-sensitively as whole words

**Failed boot**

13. `e2e` A failed connect at boot prints no password. In each case, `node dist/main.js` runs with valid settings whose `DATABASE_URL` has `<S>` as the password. Each run:
    - exits non-zero, not by a signal, within the existing e2e limit
    - writes `<S>` and the URL as loaded to neither stdout nor stderr
    - writes a non-empty stderr that says what failed, as listed below

    The cases:
    - (a) Nothing listens on the port. stderr names the refusal, for example `ECONNREFUSED`.
    - (b) A TCP listener closes each connection at once. The listener sees exactly one connection.
    - (c) A TCP listener accepts and never answers. The listener sees exactly one connection, and the boot fails through the client's connect timeout.
    - (d) The compose server, with a wrong password. stderr carries the server's authentication failure.
    - (e) A server error whose text holds `<S>`: for example the compose server with `<S>` as both the user name and the password, or a fake server that answers the startup message with an `ErrorResponse` that holds `<S>`. A control in the same test shows that the driver's raw error text holds `<S>`, and stderr shows `[REDACTED]` in its place.
14. `e2e` Settings are checked before the client connects. For each existing refusal case (`TRADER_MODE` of `live`, `testnet` or `PAPER`, `TRADER_MODE` unset, and each unparseable URL):
    - a listener at the URL's host and port sees no connection, where the URL has a host and port
    - the existing exit-code and no-leak assertions still hold

**The research role**

15. `db` After `pnpm db:migrate` on a throwaway database:
    - `research_reader` exists, with `rolcanlogin` true.
    - `rolsuper`, `rolcreatedb`, `rolcreaterole`, `rolreplication` and `rolbypassrls` are all false.
    - `pg_auth_members` shows it as a member of no role.
    - Migrating a second throwaway database, with the role already present, succeeds.
16. `db` Connected as `research_reader` with its documented password, inside `BEGIN READ WRITE`:
    - `SELECT` on the marker table succeeds.
    - `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on the marker table and on `drizzle.__drizzle_migrations` fail with SQLSTATE `42501`.
    - `CREATE TABLE` in `public` and in `drizzle` fails.
    - `ALTER TABLE` and `DROP TABLE` on the marker table fail.
    - `CREATE ROLE` and `CREATE DATABASE` fail.
17. `db` A table that `trader` creates in `public` after the migrations ran, standing in for a later migration, is readable by `research_reader`. `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on it fail.
18. `unit` `research/README.md`:
    - names `research_reader`
    - says research connects only as that role and never as `trader`
    - no longer says the first research task adds the role
    - still states every D13 boundary

    The existing toolchain checks pass unchanged. In particular, the Makefile's `db-up` recipe still does not mention research.

**Column conventions**

19. `unit` The schema scan passes on the real schema. It covers every table exported from `src/db/schema.ts`, through Drizzle's metadata, and the text of every non-spec source under `src/` that imports `drizzle-orm/pg-core`.
20. `unit` The scan's rules, on fixture tables declared in the test:
    - One fixture per banned form fails, with a message naming the table and the column. The banned forms are:
      - `real`
      - `doublePrecision`
      - `numeric` in `number` mode, and in `bigint` mode
      - `bigint` in `number` mode on a column not named `*_ms`
      - `timestamp` without a time zone
      - a `customType` column
    - A fixture with `numeric` in string mode, `timestamp({ withTimezone: true })` and `bigint('created_ms', { mode: 'number' })` passes.
21. `db` The round trip under a non-UTC time zone. It runs through the client that `src/db/client.ts` builds, on a throwaway database, in a test process whose `TZ` is `Europe/Ljubljana`. The test first asserts that `new Date('2024-01-15T12:00:00Z').getTimezoneOffset()` is not 0.
    - `timestamptz`: these instants come back with identical `getTime()`, through the Drizzle query builder and through a raw query on the same `pg` pool:
      - `2024-10-27T00:30:00.000Z` and `2024-10-27T01:30:00.000Z`, which show the same local time in that zone, an hour apart
      - `2024-03-31T00:59:59.999Z`
    - Epoch milliseconds in a number-mode `bigint` column named `*_ms` come back through Drizzle as the same `number`.
    - `numeric` values `'123456789012345678901234567890.123456789012345678'`, `'-0.00000001'` and `'1.10'` come back as identical strings through both paths.
    - Control: a `timestamp without time zone` value read through the raw pool comes back shifted by the zone's offset. This shows that the zone is in effect.

    The test tables exist only in the throwaway database, and `src/db/schema.ts` does not gain them.

**Migrations**

22. `unit` `src/db/migrations/` and `src/db/schema.ts`:
    - The journal's entries match the `.sql` files one to one, in order, and each has a snapshot.
    - `0000_init.sql` is unchanged and passes every check it has today.
    - Across all `.sql` files:
      - The only `CREATE TABLE` is the marker table.
      - `CREATE ROLE` and `ALTER ROLE` name only `research_reader`.
      - Every `GRANT` goes to `research_reader`.
      - `INSERT` targets only the marker table.
      - No file contains `DROP`, `TRUNCATE`, `DELETE` or `UPDATE`.
    - `src/db/schema.ts` declares exactly one table, the marker, and no enum, schema, view, materialized view or sequence.
23. `db` The migration inventory on a throwaway database:
    - Drizzle's migrations table has one row per journal entry.
    - Outside `drizzle`, the only objects are the marker table and the objects Postgres creates for it: its row and array types, and its constraint index.
    - A second `pnpm db:migrate` exits 0 and changes nothing.
24. `shell` drizzle-kit agrees with the committed files:
    - `pnpm db:generate` reports no schema changes and leaves `git status` clean.
    - `DOTENV_CONFIG_PATH=/dev/null pnpm exec drizzle-kit check` exits 0.
    - `build.md` shows the `pnpm db:generate` commands that produced every new migration, its journal entry and its snapshot.

**D9 and the S0d note**

25. `unit` The D9 dependency check rejects `@anthropic-ai/sdk`, `ccxt` and any name matching `/binance/i`. It checks every dependency section of `package.json`, and `pnpm-lock.yaml` through `lockedPackages()`.
    - On fixture inputs, a `package.json` object and lockfile text holding each name in turn, the check catches every one.
    - It passes on the committed files.
26. `unit` `progress.md`'s Dependencies settlement names `@isaacs/nonrecursive-glob-match` as a transitive dev package that came in through `@nestjs/cli`.

**Existing behaviour**

27. `e2e` The existing e2e assertions still hold. Successful-boot cases run against a migrated throwaway database:
    - the app exits 0 by itself
    - stdout holds JSON lines with a UTC time
    - Nest's boot lines go through pino
    - there is one startup line, with `mode: paper` and a UUID `correlationId`
    - `ANTHROPIC_API_KEY` is ignored
    - non-paper modes and unparseable URLs are refused
    - the built `AppModule` scrubs its logs
    - the password in the URL appears in no output

**Repo files**

28. `unit` `tests.json` lists every spec file exactly once. This is the existing test.
29. `unit` `progress.md`:
    - marks S0a to S0e done, says S0 is complete, and names S1a as next
    - in "Current state", describes:
      - the connection at boot through `src/db/client.ts`
      - the identity check: `DATABASE_IDENTITY`, the four reasons and the setup steps
      - `research_reader`
      - the column conventions, including the `_ms` rule
      - the scrubbed failed-boot output
    - records the hand-offs to S7a and S7b, and the runtime-output gap for S11a and S12
    - says `.env.example` has three keys

**Evidence and job boundaries**

30. `shell` With every compose project stopped and nothing listening on 55432 or 5432, `pnpm test` exits 0. `vitest list` shows that it collects no `*.db-spec.ts` file.
31. `shell` `pnpm typecheck`, `pnpm build && pnpm test:e2e` and `pnpm test:db` each exit 0. Their output is pasted into `build.md`.
32. `shell` `factory/gate.sh 005-database-client` reports `GATE: PASS` and `NEEDS_HUMAN: yes`. The orchestrator runs this.
33. `shell` `vitest list` for each of the three suites, run on `main` and on the branch, shows that the only test names removed are those under "Tests that move forward". Each removed name is listed beside its replacement.
34. `shell` Mutation checks. Revert each one, confirm the worktree is clean afterwards, and paste the output:
    - **M1.** The scrub is removed from Nest's pre-`useLogger` output only. A criterion 13 test fails.
    - **M2.** The scrub is removed from the top-level failure printer only. A criterion 13 test fails.

      If a database error cannot reach one of these paths in the chosen design, `build.md` says why, and a test reaches that path with another error that holds `<S>`.
    - **M3.** The identity decision returns `VERIFIED` on a mismatch. Criteria 7 and 10 fail.
    - **M4.** The boot inserts a marker when none is found. Criteria 11 and 12 fail.
    - **M5.** Each banned column form from criterion 20 is added to `src/db/schema.ts` in turn. Criterion 19 fails each time.
    - **M6.** `client.ts` sets `types.setTypeParser(1700, parseFloat)`. Criteria 1 and 21 fail.
    - **M7.** `GRANT INSERT` on the marker table to `research_reader` is applied in the throwaway database before the assertions run. Criterion 16 fails.
    - **M8.** `ccxt` is added to `devDependencies` in `package.json`, without installing it. Criterion 25 fails.
    - **M9.** `secretValues` drops the decoded password form. Criterion 3 fails.
35. `shell` The S0 "Done when" still holds. Set up a fresh clone whose path contains a space, with no `node_modules` and no `.env`, and work under `env -i HOME="$HOME" PATH=/usr/bin:/bin`:
    - `make db-up` exits 0.
    - The `trader` database then has one migration row per journal entry and exactly one marker row, and `research_reader` exists.
    - A second `make db-up` exits 0 and leaves the same marker, with the same value and `xmin`.
    - `make test`, `make lint` and `make typecheck` each exit 0.
36. `shell` The upgrade path, in a scratch clone:
    1. Check out `main` and run `make db-up`. Record the migration row and the volume's creation time.
    2. Check out the branch and run `make db-up`. It exits 0: the old row is unchanged, the new rows are added, and exactly one marker exists.
    3. Run `make db-up` again. The marker does not change.
    4. Build, then run `node dist/main.js` with the `.env.example` URL and `DATABASE_IDENTITY` set to that marker. It logs `VERIFIED`.

    Afterwards, remove the scratch project with its volume.
37. `shell` The diff stays inside the job:
    - `git diff --name-only main...HEAD` lists nothing under `factory/` or `.claude/`.
    - Under `research/` it lists only `research/README.md`.
    - It lists neither `CLAUDE.md`, a plan document, `docker-compose.yml` nor the `Makefile`.
    - `dependencies` and `devDependencies` in `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are unchanged.
    - `git diff --name-status --diff-filter=D main...HEAD` lists no spec file.
    - `build.md` holds the proposed `CLAUDE.md` text for the `pnpm test:e2e` comment.
38. `unit` Importing `src/app.module.ts` with an empty environment still does not throw and opens no connection.
39. `[human]` A human:
    - reads the protected changes: every file under `src/db/migrations/`, everything changed under `src/config/`, and `.env.example`
    - accepts `research_reader`, its fixed local-development password, and that migrations create it on whichever server they run against
    - confirms the spec-level choices under "Open decisions"
    - after the merge, in the main checkout:
      1. runs `make db-up` and the app once
      2. checks with `docker compose ps` that the main checkout's own container is the one answering
      3. copies the stored marker from the identity line into `DATABASE_IDENTITY` in `.env`
      4. runs the app again and sees `VERIFIED`
    - applies the `CLAUDE.md` text from `build.md`

    Agents never read `.env`, so this setup is the human's.

## Rules that apply

- **UNKNOWN blocks entries.**
  - A missing, unconfigured, different or unreadable marker is `UNKNOWN`.
  - No default, error path or fallback yields `VERIFIED` (criteria 7, 8 and 34 M3).
  - The app never "repairs" a missing marker (criteria 11 and 12).
- **Exits are asymmetric and always allowed.**
  - An identity `UNKNOWN` never fails the boot and never stops the process.
  - Nothing gates exits on the identity.
  - Only a failed connect stops the boot, as D11 already requires for a broken dependency.
- **48 entries per asset, counted inside the risk-approval transaction.** A stand-in database would read zero entries and no kill switch. This job makes that case detectable, and it hands S7a and S7b the duty to block on it.
- **Money is `Decimal`.**
  - `numeric` stays a string from the driver: no `setTypeParser`, and string-mode columns only.
  - The scan bans every column form that returns a JS `number` for money.
- **UTC everywhere.** Time columns are `timestamptz`, or epoch milliseconds in `*_ms`. The round trip under `Europe/Ljubljana` proves it, with a control.
- **Invalid data is quarantined, never silently used.** An unverified database is never used for entries, and a malformed setting simply never matches.
- **Secrets are never logged** (§5 S0, master §32):
  - Both failed-boot paths are scrubbed.
  - The client's password is one of the scrubbed forms.
  - Failures stay loud, so nothing is hidden by silence.
- **No real orders and no secrets in slice 1 (D9).**
  - The D9 dependency test now enforces the dependency rule.
  - This job adds no dependency.
  - The research password is a local-development value that the app never loads.
- **Claude cannot bypass safety.**
  - Schema changes go only through committed migrations under the protected path.
  - Claude has no database access in slice 1, because it has no tools.
- **One implementation (D13).**
  - The identity decision is a pure TypeScript function.
  - Research reads Postgres through a role that cannot write, so "never writes trading tables" is enforced by privileges, not only by the README.
- **D11: crash loudly, never blindly retry.** A failed connect fails the boot once, prints what failed and exits non-zero. There is no retry loop and no swallowed error.
- **Never delete or skip a test to go green.** Only the assertions under "Tests that move forward" change, each to assert the new behaviour, and criterion 33 checks this.
- **Factory agents never read `.env`.** Tests use fixtures, `.env.example` and throwaway databases. The human sets `DATABASE_IDENTITY`.
- **External content is data.** Database error text and the stored marker are printed scrubbed, compared exactly, and never interpreted.
- **ESM.** Relative imports end in `.js`.

This job does not touch the entry gate, EV, exit logic, the default WAIT, the look-ahead rule or the Claude window.

## Open decisions

None of the `SLICE_1_PLAN` §11 items affects this job.

The spec makes these choices where the plan is silent or where the plan and the repo disagree. Criterion 39 puts them in front of a human, and the protected paths send the job to needs-human in any case:

1. **The expected identity is a third settings key,** `DATABASE_IDENTITY`. It is optional, blank in `.env.example`, has no format check, and is compared exactly. This departs from the letter of §5 S0's two-key `.env.example`, for the reasons under "Where the plan and the repo disagree".
2. **Postgres generates the marker** in a migration, and the app never writes it.
3. **A failed connect fails the boot,** while every identity problem is `UNKNOWN` and never stops the process.
4. **`research_reader` gets a fixed local-development password** written in a migration, and is created on every server the migrations run against.
5. **Epoch-millisecond `bigint` columns are recognised by the `_ms` name suffix.**
6. **`pnpm test:e2e` now needs the compose Postgres.**
