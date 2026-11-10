# Build: 005-database-client (S0e)

Branch `factory/005-database-client`. Four commits on `main` (9b2df85). The last is `c0c087a`, and every pasted output below was taken at `c0c087a`, apart from the exploration in "Criterion 3".

`pnpm install --frozen-lockfile`, `pnpm test` (558 tests), `pnpm lint` and `pnpm build` pass. `pnpm typecheck`, `pnpm test:e2e` (36 tests) and `pnpm test:db` (58 tests) pass too; their output is under criterion 31. No stop condition was hit, no dependency was added, and `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are unchanged.

## What changed

**The client (`src/db/client.ts`).** It is the only file under `src/` that imports `pg` or the node-postgres driver.
- `databaseConfig(settings)` builds the `pg` pool config from the parsed settings alone. `connectDatabase(settings)` creates the pool and the Drizzle instance (with the schema), proves one connection, reads the marker, and returns `{ db, marker, close }`.
- **No `connectionString`.** The URL is parsed by `databaseTarget()` in `src/config/secrets.ts`, which uses the same WHATWG parser as `secretValues`. The client's password is therefore `decodeURIComponent(url.password)`, or `url.password` when that does not decode. Both are forms `secretValues` returns. See "Criterion 3" for why `pg`'s own parser could not stay.
- **No environment fallback.** `pg` fills any falsy field from the environment. The config sets:
  - every field `pg` would look up: host, port, user, password, database, `ssl`, `sslnegotiation`, `client_encoding`, `application_name`, `replication` and `options`
  - the libpq defaults where the URL is silent: port 5432, the OS user (`os.userInfo()`), and a database named after the user
  - a function returning `''` for a URL with no password, so neither `PGPASSWORD` nor `.pgpass` is read
- **Bounds.**
  - The connect timeout is **5 seconds** (`CONNECT_TIMEOUT_MS`).
  - The marker read has its own 5-second `query_timeout`. A read that times out is `unreadable`.
  - There is no retry: one failed connect rejects, and the pool is ended.
- **No type parser changes.** `numeric` and `int8` stay strings, and `timestamptz` keeps the driver's parsing. Drizzle's per-query timestamp mapping is its own and is untouched.

**Nest wiring (`src/db/db.module.ts`).** `DbModule` is imported by `AppModule` after `LoggerModule`.
- It provides `DATABASE_CONNECTION` (connected while the context is created), `DATABASE` (the Drizzle instance) and `IDENTITY` (the decision).
- It ends the pool in `onApplicationShutdown`. The pool also has `allowExitOnIdle: true`, so an idle pool never holds the process open.
- See "For reviewers" item 1 for the `null` guard on the connection factory.

**The identity marker.**
- `src/db/schema.ts` holds one table, `database_identity`:
  - `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`, so the table holds at most one row
  - `marker uuid NOT NULL`
  - `created_at timestamptz NOT NULL DEFAULT now()`
- Migration `0002` inserts the row with `gen_random_uuid()`. The app never writes it.
- `src/db/identity.ts` is pure: no imports at all and no `process.`.
  - `decideIdentity(expected, read)` returns `VERIFIED` only on an exact match with a single stored row.
  - Every other outcome is `UNKNOWN`, with `not_configured`, `missing_marker` (42P01, or no row), `mismatch` or `unreadable`. Two rows also count as `unreadable`.
  - `not_configured` takes precedence, so an unset setting reads `not_configured` whatever the database holds.
  - `blocksEntries` is `status !== 'VERIFIED'`, so an unexpected status also blocks.
- `main.ts` logs one `Database identity` line before the startup line: `info` for `VERIFIED`, `warn` for `UNKNOWN`. It carries `status`, `reason` and, when one row exists, `marker`.

**Settings.**
- `DATABASE_IDENTITY` is `z.string().transform(blank → undefined).optional()`. Unset, empty and whitespace-only (JS `trim`) parse as `undefined`. Anything else is kept as written.
- It is not in `secretValues`.
- `.env.example` gains `DATABASE_IDENTITY=`.

**The research role (migration `0003`).**
- A `DO` block creates `research_reader` when `pg_roles` lacks it. A nested exception block makes two databases migrating at the same moment safe.
- `ALTER ROLE` then sets `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'research-local-dev-only'` either way, plus `default_transaction_read_only = on` on top of the privileges.
- In each database it grants `CONNECT` (through `format('%I', current_database())`), `USAGE` on `public` and `SELECT` on all tables in `public`. `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES` covers later tables.
- `research/README.md` documents the role and the URL.

**Failed-boot output (`src/config/boot-output.ts`).**
- `ConfigModule` records `secretValues(settings)` from its one parse (`recordBootSecrets`).
- `main.ts` passes a `BootConsoleLogger` as `logger`. That is Nest's `ConsoleLogger` with `formatMessage` and `printStackTrace` scrubbed, and colours off. It replaces the default logger, which printed the `ExceptionHandler` line and flushed the buffered boot lines unscrubbed.
- `main.ts` ends with `await runWithCorrelation(bootstrap).catch(printBootFailure)`. That function writes `scrubSecrets(inspect(error))` to stderr and sets `process.exitCode = 1`.
- `process.env` is still read only in `config.module.ts`.

**Repo files.**
- `progress.md`: S0e done, S0 complete, S1a next, and the S0e current state with the setup steps. It also records hand-offs to S7a, S7b, S11a and S12, three keys, `@isaacs/nonrecursive-glob-match`, the `_ms` rule and the no-compose-`name:` reason.
- `tests.json`: 33 entries, each spec once.
- The e2e config runs files one at a time, with longer hook timeouts.

**Tests.**
- New unit specs:
  - `test/unit/config/boot-output.spec.ts`
  - `test/unit/db/client.spec.ts`
  - `test/unit/db/db-module.spec.ts`
  - `test/unit/db/identity.spec.ts`
  - `test/unit/db/schema-scan.spec.ts`, with the scanner in `test/fixtures/schema-scan.ts`
- New DB specs: `test/db/identity.db-spec.ts`, `research-role.db-spec.ts`, `round-trip.db-spec.ts` and `client.db-spec.ts`.
- New e2e spec: `test/database-boot.e2e-spec.ts`.
- New fixtures:
  - `test/fixtures/main.ts`: the child-process runner, moved out of `app.e2e-spec.ts`, plus counting TCP listeners
  - `test/fixtures/database.ts`: a fake connection
  - shared guarded helpers in `test/fixtures/db.ts`

## Acceptance criteria

| # | How | Proof |
|---|---|---|
| 1 | unit | `drizzle.spec.ts` "only src/db/client.ts connects": seven patterns match no non-spec source but `client.ts`; `client.ts` imports `pg` and the driver and builds the pool; no `setTypeParser`; `new URL(` only in `secrets.ts`; `process.env` only in `config.module.ts`; "AppModule imports ConfigModule, LoggerModule and DbModule". |
| 2 | unit | `client.spec.ts` "databaseConfig: the parameters come from DATABASE_URL alone". Twelve `PG*` variables hold sentinels in every test, and a control shows a bare `pg.Client` does read them. It covers the full URL (`db.example`, 6543, `u`, `<S>`, `name`), no port (5432), no password (`''`, never the `PGPASSWORD` sentinel), no user (the OS user), no database (the user), port 0, IPv6, an ignored query string, and the other `PG*` variables. |
| 3 | unit | `client.spec.ts` "the client's password is a scrubbed form (S0c review)": the three S0c encoded URLs, the recorded counterexample, a URL that makes `pg` throw, and a 2,000-run `fc.asyncProperty` over `databaseUrls`. It requires that nothing throws, that a non-empty password is one of `secretValues`, and that no password means `secretValues` is `[]` and the client sends `''`. |
| 4 | db | `client.db-spec.ts` "leaves no connection in pg_stat_activity once the context is closed". As a control, it first sees ≥ 1 connection with `application_name = 'local-trading-agent'`. |
| 5 | unit | `settings.spec.ts`: "has exactly the keys DATABASE_URL, TRADER_MODE and DATABASE_IDENTITY", "types the settings as exactly the three keys" (`expectTypeOf`), and the "parseSettings: DATABASE_IDENTITY" block. That block covers unset, empty and blank values, values kept as written, a 1,000-run property that no value throws, key names only in `SettingsError`, and that the key is not a secret. All earlier settings cases pass unchanged. |
| 6 | unit | `repo-files.spec.ts` ".env.example": the three schema keys, `DATABASE_IDENTITY` blank, "passes parseSettings as it is", and the `DATABASE_URL` and `TRADER_MODE=paper` lines unchanged. |
| 7 | unit | `identity.spec.ts` "decideIdentity": 15 table rows covering upper case, leading and trailing whitespace, a prefix and an extension, plus a 2,000-run property. "src/db/identity.ts stays pure": no `@nestjs/`, `pg`, `drizzle-orm` or `process.`, no import at all, and one `VERIFIED` return. |
| 8 | unit | `identity.spec.ts` "blocksEntries": each of the four reasons blocks, `VERIFIED` does not, and an unknown status blocks. "types the status and the reason as exact unions" covers both unions. |
| 9 | db | `identity.db-spec.ts`: one UUID v4 row, `created_at` is `timestamp with time zone`, two databases differ, a second migrate leaves value and `xmin` unchanged, and a second row fails as `trader` (23505 by default, 23514 with `singleton = false`). |
| 10 | e2e | `database-boot.e2e-spec.ts` "the identity line at boot": six runs, each exiting 0 with exactly one identity line before the startup line, at the level, status, reason and marker the spec lists. |
| 11 | e2e | Same file, "the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)", once per run. State is recorded right after each run: both markers with `xmin`, every relation, function and type in the unmigrated database, and no `drizzle` schema there. |
| 12 | unit | `drizzle.spec.ts` "the app never writes the marker (S0e)": no migrator import and no `migrate(`, no `.insert(`, `.update(` or `.delete(`, and none of the eight words (case-sensitive, whole word) outside `src/db/migrations/`. |
| 13 | e2e | `database-boot.e2e-spec.ts` "a failed connect at boot prints no password" (a) to (e). Each run must exit non-zero with no signal and no timeout, and write non-empty stderr with neither `<S>` nor the URL on either stream. (a) ECONNREFUSED. (b) One connection, `ECONNRESET` or "Connection terminated". (c) One connection, elapsed ≥ 5 s and < 10 s, `timeout`. (d) `password authentication failed for user "trader"` and 28P01. (e) The compose server with `<S>` as user and password: the control shows the driver's raw message holds `<S>`, and stderr shows `for user "[REDACTED]"`. Unit counterparts are in `boot-output.spec.ts`. |
| 14 | e2e | `app.e2e-spec.ts` "node dist/main.js with invalid env": each `TRADER_MODE` case and the unset case point `DATABASE_URL` at a counting listener, which sees 0 connections. The exit-code and no-leak assertions are unchanged. The unparseable URLs have no usable host and port, so they keep their existing assertions. Unit counterpart: `db-module.spec.ts` "never connects when the settings are refused". |
| 15 | db | `research-role.db-spec.ts` "research_reader, the role": login only, all five attributes false, a member of no role, and a second database migrates with the role present. |
| 16 | db | Same file, "connected as research_reader with its documented password". The password is parsed out of `research/README.md`. Controls show `current_user` and that `BEGIN READ WRITE` is read-write. `SELECT` works, and 13 statements fail with 42501. `CREATE DATABASE` cannot run in a transaction block, so it runs on its own with the read-only default switched off, and gets 42501. |
| 17 | db | Same file, "a table that trader creates after the migrations ran": readable, and four writes fail with 42501. |
| 18 | unit | `research.spec.ts`: three new README tests (the role and URL, "only as `research_reader`, never as `trader`", no longer "the first research task adds the role"). The D13 and toolchain checks are unchanged, including the `db-up` recipe check. |
| 19 | unit | `schema-scan.spec.ts` "the real schema follows the column conventions": metadata (`getTableConfig`) over every exported table, and the source text of every non-spec file importing `drizzle-orm/pg-core`, comments stripped. |
| 20 | unit | `schema-scan.spec.ts` "the scanner": one fixture table per banned form fails, naming table and column. The source layer fails on the same forms. The allowed fixture passes: string `numeric`, `timestamptz` and `bigint('created_ms', { mode: 'number' })`. |
| 21 | db | `round-trip.db-spec.ts`. `TZ=Europe/Ljubljana`, and the precondition offset is −60. The client comes from `connectDatabase`. Both autumn instants and the spring instant round-trip through Drizzle and the raw pool. `at_ms` comes back as the same number. The three `numeric` strings are identical through both paths. Control: `timestamp without time zone` shifts by the zone's offset. |
| 22 | unit | `drizzle.spec.ts` "src/db/schema.ts" and "src/db/migrations": journal, files and snapshots match one to one; `0000_init.sql` is the drizzle-kit comment byte for byte and still has none of the eight keywords; the only `CREATE TABLE` is the marker; roles and grants name only `research_reader`; privileges are only `CONNECT`, `USAGE` and `SELECT`; the one `INSERT` uses `gen_random_uuid()`; and no `DROP`, `TRUNCATE`, `DELETE` or `UPDATE` (case-insensitive). |
| 23 | db | `migrate.db-spec.ts`: one row per journal entry; outside `drizzle` only `database_identity`, its row and array types, and `database_identity_pkey`; and a second run exits 0 with the same rows and the same object inventory. |
| 24 | shell | See "Criterion 24". |
| 25 | unit | `dependencies.spec.ts` "D9: no Anthropic SDK and no exchange client in the dependency tree": seven fixture names in each of six manifest sections and in a fixture lockfile through `lockedPackages()`, plus the committed `package.json` and lockfile. |
| 26 | unit | `repo-files.spec.ts` "names @isaacs/nonrecursive-glob-match as a transitive dev package from @nestjs/cli". |
| 27 | e2e | `app.e2e-spec.ts`: every earlier case passes, with successful boots on a migrated throwaway database. "writes neither fixture secret" now checks the loaded password and URL, since the fixture password cannot log in. |
| 28 | unit | `repo-files.spec.ts` "lists every spec file exactly once" (unchanged). |
| 29 | unit | `repo-files.spec.ts` "progress.md": "marks S0a, S0b, S0c and S0d done" (unchanged), "marks S0e done", "says S0 is complete and names S1a as next", "Current state describes S0e" (11 needles plus the setup order), "records the hand-offs to S7a, S7b, S11a and S12", "records that .env.example has three keys", and the value-scrub test (unchanged). |
| 30 | shell | See "Criterion 30". |
| 31 | shell | See "Criterion 31". |
| 32 | shell | Run by the orchestrator. I did not run `factory/gate.sh`, because it writes into `factory/`. Its checks are covered above, and the tripwire and skip scans, run with the gate's own regexes, are under criterion 37. Expect `GATE: PASS` and `NEEDS_HUMAN: yes`, because `.env.example`, `src/config/` and `src/db/migrations/` changed. |
| 33 | shell | See "Criterion 33". |
| 34 | shell | See "Criterion 34". |
| 35 | shell | See "Criterion 35". |
| 36 | shell | See "Criterion 36". |
| 37 | shell | See "Criterion 37". The proposed `CLAUDE.md` text is below. |
| 38 | unit | `client.spec.ts` "importing src/app.module.ts > does not throw with an empty environment, and opens no connection". It clears every setting, points `PGHOST`/`PGPORT` at a counting listener, runs `vi.resetModules()` and imports the module, and the listener sees 0 connections. `config.module.spec.ts` "does not throw with an empty environment" also still passes. |
| 39 | [human] | Not provable by an agent. See "For the human". |

## Criterion 3: the counterexample and the fix

Before writing the client, I ran the criterion 3 property against `pg`'s own derivation, `new pg.Client({ connectionString })`, in a throwaway spec that was deleted afterwards. With seed 1 and 5,000 draws, 984 of the 3,035 accepted URLs failed:

```
"postgresql://trader:a%20%zz-S@localhost:5432/trader" {"password":"a %zz-S"} ["a%20%zz-S"]
"postgresql://trader:pw%22q%5Cs%40-S@localhost:5432/trader" {"password":"pw\"q\\s@-S"} ["pw%22q%5Cs%40-S","pw\\\"q\\\\s@-S","pw\"q\\s@-S"]
"postgresql://trader:mix@d%20S@localhost:5432/trader" {"password":"mix@d S"} ["mix%40d%20S","mix@d S"]
"postgresql://trader:pa%zz-S@localhost:5432/trader" {"password":"pa%zz-S"} ["pa%zz-S"]
"postgresql://trader:x%C3-S@localhost:5432/trader" {"error":"URIError: URI malformed"} ["x%C3-S"]
"postgresql://trader:x\ud800-S@localhost:5432/trader" {"password":"x�-S"} ["x%EF%BF%BD-S","x�-S"]
"CE" "postgresql://iYZ+:%%. @M@пример.рф/\u001a\u001c" {"password":"%%. @M"}
"CE" "POSTGRES://q'X(:@P%z򍎚􍊿~@yno3gb1pvr.eu:37242/ꌁ𝍬∕ ꈍ⬽?8Oaer(_t<#𑈝𖨉" {"password":"@P%z򍎚􍊿~"}
"CE" "postgresql://*g_p1M8:%-1@@%75@db/𛃂?I" {"password":"%-1@@u"}
"CE" "\u001a\u001aPOSTGRESQL://1(3S.'0xk: @%D7@180.4.168.106:?" {"password":null}
"CE" "PostgreSQL://4zAeiw=:@{%zz%C33OFXmHybT@[16d:bb3f:95:4:ef2::f]/trader" {"error":"TypeError: Invalid URL"}
"CE" "\u001d\u0000Postgres://g:|%zz@35.187.67.241/𐁝𐴵፼ꈰ𑤁𛋘𝥃𔖳𐕸𓋠?us]=ds#⧩" {"password":null}
"accepted" 3035 "counterexamples" 984
```

The four failure kinds:
- **A form the scrub does not know.** `pg-connection-string` re-encodes a URL that holds a space or an invalid `%` sequence (`encodeURI`, then un-escapes `%25dd`) before parsing. `a%20%zz-S` becomes `a %zz-S`, while `secretValues` holds only `a%20%zz-S`, because the whole password does not decode.
- **A throw, so a refused boot.** `x%C3-S` makes `decodeURIComponent` throw `URIError`, and a few others throw `TypeError: Invalid URL`.
- **A `null` password.** A leading C0 control makes its relative-URL parse lose the userinfo. `pg` then reads `PGPASSWORD`.
- **Query parameters override the URL.** `?host=`, `?password=` and `?sslrootcert=` (a file read) all take precedence.

**The fix.** The client no longer gives `pg` a connection string. `databaseTarget()` in `secrets.ts` parses the URL with the same WHATWG parser and the same decode rule as `secretValues`, so the client's password is one of its forms by construction. The query string is ignored. `secretValues` is unchanged, and the generator was not narrowed. `client.spec.ts` keeps `a%20%zz-<S>` and `x%C3-<S>` as fixed regression cases, each with a control that shows what `pg` itself would do.

## Criterion 24: drizzle-kit agrees with the committed files

The new migrations came from these commands, run in `local-trading-agent-backend/`. Each wrote its `.sql`, its journal entry and its snapshot. Only the bodies of the two custom `.sql` files were written by hand, below drizzle-kit's comment line. The journal and the snapshots were not edited.

```
$ pnpm db:generate --name database_identity
1 tables
database_identity 3 columns 0 indexes 0 fks
[✓] Your SQL migration file ➜ src/db/migrations/0001_database_identity.sql 🚀
$ pnpm db:generate --custom --name database_identity_marker
Prepared empty file for your custom SQL migration!
[✓] Your SQL migration file ➜ src/db/migrations/0002_database_identity_marker.sql 🚀
$ pnpm db:generate --custom --name research_reader
Prepared empty file for your custom SQL migration!
[✓] Your SQL migration file ➜ src/db/migrations/0003_research_reader.sql 🚀
```

At `c0c087a`:

```
HEAD c0c087a
$ pnpm db:generate
1 tables
database_identity 3 columns 0 indexes 0 fks

No schema changes, nothing to migrate 😴
exit=0
$ git status --short
(clean if nothing above)
$ DOTENV_CONFIG_PATH=/dev/null pnpm exec drizzle-kit check
Everything's fine 🐶🔥
exit=0
```

## Criterion 30: `pnpm test` with no database anywhere

Every compose project I created had been removed with its volume; `docker ps` lists nothing.

```
HEAD c0c087a
$ docker ps --format "{{.Names}} {{.Ports}}"
(no running container)
$ lsof -nP -iTCP:55432 -iTCP:5432 -sTCP:LISTEN
lsof exit=1 (1 = nothing listening)
$ pnpm test
 Test Files  25 passed (25)
      Tests  558 passed (558)
   Start at  19:01:40
   Duration  2.73s (transform 782ms, setup 0ms, import 9.87s, tests 5.34s, environment 1ms)

exit=0
$ ./node_modules/.bin/vitest list --filesOnly | grep -c db-spec
0
$ ./node_modules/.bin/vitest list --filesOnly | wc -l
      25
```

## Criterion 31: typecheck, e2e and DB suites

These ran against this worktree's own compose project (`005-database-client`, created by `make db-up` in the worktree and removed with `down -v` afterwards).

```
HEAD c0c087a
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json
exit=0
```

```
HEAD c0c087a
$ pnpm build && pnpm test:e2e --reporter=verbose
$ pnpm typecheck && nest build
$ tsc --noEmit -p tsconfig.json
$ vitest run --config ./vitest.config.e2e.ts --reporter=verbose
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'DATABASE_IDENTITY unset': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'DATABASE_IDENTITY set to \'\'': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'the database\'s own marker': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'another database\'s marker': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'the marker in upper case': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'any UUID, on a database with no migra…': exits 0 and logs exactly one identity line before the startup line
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'DATABASE_IDENTITY unset': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'DATABASE_IDENTITY set to \'\'': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'the database\'s own marker': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'another database\'s marker': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'the marker in upper case': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > the identity line at boot > 'any UUID, on a database with no migra…': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (a) nothing listens on the port: stderr names the refusal
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (b) a listener closes each connection at once: one connection, no retry
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (c) a listener accepts and never answers: the connect timeout fails the boot
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (d) the compose server with a wrong password: the authentication failure
 ✓ test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (e) a server error that holds the password: [REDACTED] in its place
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > exits 0 by itself within the limit
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > writes only JSON lines with level, msg and a UTC time
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > routes Nest's own boot lines through pino
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > logs one startup line with the mode and a UUID correlationId
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > writes neither fixture secret
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > the valid env holds only DATABASE_URL and TRADER_MODE
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > exits 0 by itself when the environment holds a key
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > writes the key to neither stdout nor stderr
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=live without leaking secrets
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=testnet without leaking secrets
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=PAPER without leaking secrets
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses to start when TRADER_MODE is unset
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses a port out of range without leaking the password
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses an unclosed IPv6 bracket without leaking the password
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses a space in the host without leaking the password
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > exits 0 with nothing on stderr
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes only clean JSON lines to stdout
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > passes Nest's buffered boot lines through the same logger
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes [REDACTED] where each secret was
 Test Files  2 passed (2)
      Tests  36 passed (36)
exit=0
```

```
HEAD c0c087a
$ pnpm test:db --reporter=verbose
$ vitest run --config ./vitest.config.db.ts --reporter=verbose
 ✓ test/db/research-role.db-spec.ts > research_reader, the role > exists, can log in, and has no other attribute
 ✓ test/db/research-role.db-spec.ts > research_reader, the role > is a member of no role
 ✓ test/db/research-role.db-spec.ts > research_reader, the role > migrating a second database, with the role already present, succeeds
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > is connected as research_reader, in read-only sessions by default
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > control: BEGIN READ WRITE really opens a read-write transaction
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > can read the marker table
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > INSERT on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > UPDATE on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > DELETE on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > TRUNCATE on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > INSERT on the migrations table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > UPDATE on the migrations table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > DELETE on the migrations table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > TRUNCATE on the migrations table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > CREATE TABLE in public fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > CREATE TABLE in drizzle fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > ALTER TABLE on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > DROP TABLE on the marker table fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > CREATE ROLE fails with 42501
 ✓ test/db/research-role.db-spec.ts > connected as research_reader with its documented password > CREATE DATABASE fails with 42501
 ✓ test/db/research-role.db-spec.ts > a table that trader creates after the migrations ran > is readable by research_reader
 ✓ test/db/research-role.db-spec.ts > a table that trader creates after the migrations ran > INSERT INTO public.later_table VALUES (2) fails with 42501
 ✓ test/db/research-role.db-spec.ts > a table that trader creates after the migrations ran > UPDATE public.later_table SET id = 3 fails with 42501
 ✓ test/db/research-role.db-spec.ts > a table that trader creates after the migrations ran > DELETE FROM public.later_table fails with 42501
 ✓ test/db/research-role.db-spec.ts > a table that trader creates after the migrations ran > TRUNCATE public.later_table fails with 42501
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > exits 0
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > records one row per journal entry in drizzle's migrations table
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > creates nothing outside drizzle but the marker table and what Postgres makes for it
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > the inventory does see drizzle's own table
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > prints neither the URL nor its password
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > a second run exits 0 and changes nothing
 ✓ test/db/migrate.db-spec.ts > withTestDatabase against the server > drops the database even when the body throws
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero when DATABASE_URL is unset
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero on a wrong password, applies nothing, and hides it
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero when no server listens on the port, and hides the password
 ✓ test/db/round-trip.db-spec.ts > the precondition > runs with a non-UTC local zone
 ✓ test/db/round-trip.db-spec.ts > the precondition > the two autumn instants show the same local time
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-10-27T00:30:00.000Z comes back with the same getTime() through Drizzle
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-10-27T01:30:00.000Z comes back with the same getTime() through Drizzle
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-03-31T00:59:59.999Z comes back with the same getTime() through Drizzle
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-10-27T00:30:00.000Z comes back with the same getTime() through the raw pool
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-10-27T01:30:00.000Z comes back with the same getTime() through the raw pool
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > timestamptz 2024-03-31T00:59:59.999Z comes back with the same getTime() through the raw pool
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > epoch milliseconds in a number-mode *_ms bigint come back as the same number
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > numeric comes back as the identical string through Drizzle
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > numeric comes back as the identical string through the raw pool
 ✓ test/db/round-trip.db-spec.ts > a round trip through the client > control: timestamp without time zone through the raw pool shifts by the local offset
 ✓ test/db/client.db-spec.ts > connectDatabase > reads the single marker of a migrated database
 ✓ test/db/client.db-spec.ts > connectDatabase > reads no table in a database with no migrations applied
 ✓ test/db/client.db-spec.ts > connectDatabase > runs its session in UTC whatever the server says
 ✓ test/db/client.db-spec.ts > the application context and its connections > leaves no connection in pg_stat_activity once the context is closed
 ✓ test/db/identity.db-spec.ts > the database identity marker > pnpm db:migrate leaves exactly one row, holding a UUID
 ✓ test/db/identity.db-spec.ts > the database identity marker > records when the row was made, as timestamptz
 ✓ test/db/identity.db-spec.ts > the database identity marker > two databases get different markers
 ✓ test/db/identity.db-spec.ts > the database identity marker > a second pnpm db:migrate leaves the value and xmin unchanged
 ✓ test/db/identity.db-spec.ts > the database identity marker > a second row fails as trader, by default or explicitly
 ✓ test/db/server.db-spec.ts > the compose Postgres server > runs major version 16
 ✓ test/db/server.db-spec.ts > the compose Postgres server > uses UTC
 Test Files  6 passed (6)
      Tests  58 passed (58)
exit=0
```

## Criterion 33: test names, `main` (9b2df85) against the branch (c0c087a)

`vitest list` ran for each config. `main` came from `git archive 9b2df85` into a scratch folder, using this worktree's `node_modules`, since the dependency files are identical. Counts per suite, main → branch: unit 376 → 558, e2e 20 → 36, db 12 → 58. These are every name removed, each beside its replacement. All of them are under "Tests that move forward".

| Removed (on `main`) | Replacement (on the branch) |
|---|---|
| settings > returns exactly DATABASE_URL and TRADER_MODE | settings > has exactly the keys DATABASE_URL, TRADER_MODE and DATABASE_IDENTITY |
| settings > types the settings as exactly the two keys | settings > types the settings as exactly the three keys |
| drizzle > src/db/migrations > holds exactly one .sql file | drizzle > src/db/migrations > has one journal entry per .sql file, in order, each with a snapshot |
| drizzle > src/db/migrations > has one journal entry naming that file, with a snapshot | the same new test |
| drizzle > src/db/migrations > the migration has no {ALTER, CREATE, DELETE, DROP, GRANT, INSERT, TRUNCATE, UPDATE} (8 names) | drizzle > src/db/migrations > 0000_init.sql has no {the same 8}, plus "keeps 0000_init.sql as the comment drizzle-kit wrote" |
| drizzle > src/db/schema.ts > declares no pgTable | drizzle > src/db/schema.ts > declares exactly one table, the identity marker |
| drizzle > src/db/schema.ts > imports nothing | drizzle > src/db/schema.ts > imports only drizzle-orm and drizzle-orm/pg-core |
| drizzle > the app stays unconnected > no non-spec source under src/ matches {7 patterns} (7 names) | drizzle > only src/db/client.ts connects > no non-spec source under src/ but client.ts matches {the same 7}, plus "client.ts imports pg and the node-postgres driver, and builds the pool", "no non-spec source under src/ contains setTypeParser" and the `new URL(` / `process.env` checks |
| drizzle > the app stays unconnected > AppModule imports only ConfigModule and LoggerModule | drizzle > only src/db/client.ts connects > AppModule imports ConfigModule, LoggerModule and DbModule |
| repo-files > .env.example > has exactly DATABASE_URL and TRADER_MODE, the settings schema keys | repo-files > .env.example > has exactly the settings schema keys: DATABASE_URL, TRADER_MODE and DATABASE_IDENTITY |
| repo-files > progress.md > names S0e as next | repo-files > progress.md > marks S0e done; says S0 is complete and names S1a as next |
| repo-files > progress.md > says S0e remains open under S0 | repo-files > progress.md > says S0 is complete and names S1a as next |
| repo-files > progress.md > records that .env.example has two keys | repo-files > progress.md > records that .env.example has three keys |
| e2e > node dist/main.js and the database > boots and exits 0 without connecting | criterion 13: database-boot e2e "a failed connect at boot prints no password" (a) to (e); criterion 14: app e2e "with invalid env" listener assertions |
| db > migrate > records exactly one row in drizzle's migrations table | db > migrate > records one row per journal entry in drizzle's migrations table |
| db > migrate > creates nothing outside drizzle's bookkeeping schema | db > migrate > creates nothing outside drizzle but the marker table and what Postgres makes for it |
| db > migrate > a second run exits 0 and leaves the same single row | db > migrate > a second run exits 0 and changes nothing |

The raw `comm -23` output, with the file prefixes:

```
--- vitest.config.ts
test/unit/config/settings.spec.ts > parseSettings: valid input > returns exactly DATABASE_URL and TRADER_MODE
test/unit/config/settings.spec.ts > parseSettings: valid input > types the settings as exactly the two keys
test/unit/db/drizzle.spec.ts > src/db/migrations > has one journal entry naming that file, with a snapshot
test/unit/db/drizzle.spec.ts > src/db/migrations > holds exactly one .sql file
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no ALTER
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no CREATE
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no DELETE
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no DROP
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no GRANT
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no INSERT
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no TRUNCATE
test/unit/db/drizzle.spec.ts > src/db/migrations > the migration has no UPDATE
test/unit/db/drizzle.spec.ts > src/db/schema.ts > declares no pgTable
test/unit/db/drizzle.spec.ts > src/db/schema.ts > imports nothing
test/unit/db/drizzle.spec.ts > the app stays unconnected > AppModule imports only ConfigModule and LoggerModule
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /\bdrizzle\(/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /drizzle-orm\/node-postgres/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /from\s+['"]pg['"]/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /import\(\s*['"]pg['"]\s*\)/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /new\s+Client\(/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /new\s+Pool\(/
test/unit/db/drizzle.spec.ts > the app stays unconnected > no non-spec source under src/ matches /require\(\s*['"]pg['"]\s*\)/
test/unit/tooling/repo-files.spec.ts > .env.example > has exactly DATABASE_URL and TRADER_MODE, the settings schema keys
test/unit/tooling/repo-files.spec.ts > progress.md > names S0e as next
test/unit/tooling/repo-files.spec.ts > progress.md > records that .env.example has two keys
test/unit/tooling/repo-files.spec.ts > progress.md > says S0e remains open under S0
--- vitest.config.e2e.ts
test/app.e2e-spec.ts > node dist/main.js and the database > boots and exits 0 without connecting
--- vitest.config.db.ts
test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > a second run exits 0 and leaves the same single row
test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > creates nothing outside drizzle's bookkeeping schema
test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > records exactly one row in drizzle's migrations table
```

## Criterion 34: mutation checks

Each mutation was applied by a script, run, then reverted with `git checkout -- .`. `git status --short` was empty after each. All ran at `c0c087a` with this worktree's compose project up. Afterwards `dist/` was rebuilt from the committed source.

- **M1 and M2.** A database error reaches both paths in this design. The connect runs in a provider factory, so a failed connect goes through Nest's `ExceptionsZone` (the `ExceptionHandler` line, printed by the pre-`useLogger` logger) and is then rethrown to `printBootFailure`. Case (e) catches each mutation alone, and so do the unit tests in `boot-output.spec.ts`.
- **M4** inserts the marker and, as the scenario this job exists to catch requires, first creates the table when it is missing.
- **M5** adds one column of each banned form to the real marker table.
- **M8** runs `vitest` directly; see "For reviewers" item 2.

```
=== M1 (HEAD c0c087a)
 1 file changed, 9 insertions(+), 12 deletions(-)
$ pnpm test
 FAIL  test/unit/config/boot-output.spec.ts > BootConsoleLogger (Nest's output before useLogger) > scrubs an error message and its stack on stderr
 FAIL  test/unit/config/boot-output.spec.ts > BootConsoleLogger (Nest's output before useLogger) > scrubs a message with a separate stack argument
 FAIL  test/unit/config/boot-output.spec.ts > BootConsoleLogger (Nest's output before useLogger) > scrubs plain log lines on stdout, buffered ones included
 FAIL  test/unit/config/boot-output.spec.ts > a failed Nest boot prints no password on either path > scrubs the ExceptionHandler line, the flushed boot lines and the rethrown error
 Test Files  1 failed | 24 passed (25)
      Tests  4 failed | 554 passed (558)
exit=1
$ pnpm build && pnpm test:e2e
 FAIL  test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (e) a server error that holds the password: [REDACTED] in its place
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 35 passed (36)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M2 (HEAD c0c087a)
 1 file changed, 1 insertion(+), 1 deletion(-)
$ pnpm test
 FAIL  test/unit/config/boot-output.spec.ts > printBootFailure (the printer for the rejected bootstrap) > writes the error to stderr with [REDACTED] for every secret form
 FAIL  test/unit/config/boot-output.spec.ts > a failed Nest boot prints no password on either path > scrubs the ExceptionHandler line, the flushed boot lines and the rethrown error
 Test Files  1 failed | 24 passed (25)
      Tests  2 failed | 556 passed (558)
exit=1
$ pnpm build && pnpm test:e2e
 FAIL  test/database-boot.e2e-spec.ts > a failed connect at boot prints no password > (e) a server error that holds the password: [REDACTED] in its place
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 35 passed (36)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M3 (HEAD c0c087a)
 1 file changed, 1 insertion(+), 1 deletion(-)
$ pnpm test
 FAIL  test/unit/db/db-module.spec.ts > DbModule > provides the identity when DATABASE_IDENTITY is another marker
 FAIL  test/unit/db/db-module.spec.ts > DbModule > provides the identity when DATABASE_IDENTITY is the stored marker in upper case
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > another marker
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > upper case
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > leading space
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > trailing newline
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > a prefix of the marker
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > the marker extended
 FAIL  test/unit/db/identity.spec.ts > decideIdentity > is VERIFIED exactly when configured and equal to the single stored marker
 FAIL  test/unit/db/identity.spec.ts > src/db/identity.ts stays pure > returns VERIFIED from exactly one place
 Test Files  2 failed | 23 passed (25)
      Tests  10 failed | 548 passed (558)
exit=1
$ pnpm build && pnpm test:e2e
 FAIL  test/database-boot.e2e-spec.ts > the identity line at boot > 'another database\'s marker': exits 0 and logs exactly one identity line before the startup line
 FAIL  test/database-boot.e2e-spec.ts > the identity line at boot > 'the marker in upper case': exits 0 and logs exactly one identity line before the startup line
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 34 passed (36)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M4 (HEAD c0c087a)
 1 file changed, 8 insertions(+), 1 deletion(-)
$ pnpm test
 FAIL  test/unit/db/drizzle.spec.ts > the app never writes the marker (S0e) > no non-spec source outside the migrations contains the word INSERT
 FAIL  test/unit/db/drizzle.spec.ts > the app never writes the marker (S0e) > no non-spec source outside the migrations contains the word CREATE
 Test Files  1 failed | 24 passed (25)
      Tests  2 failed | 556 passed (558)
exit=1
$ pnpm build && pnpm test:e2e
 FAIL  test/database-boot.e2e-spec.ts > the identity line at boot > 'any UUID, on a database with no migra…': exits 0 and logs exactly one identity line before the startup line
 FAIL  test/database-boot.e2e-spec.ts > the identity line at boot > 'any UUID, on a database with no migra…': the boot writes nothing (marker value and xmin unchanged, unmigrated database still empty)
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 34 passed (36)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-real (HEAD c0c087a)
 1 file changed, 2 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-doublePrecision (HEAD c0c087a)
 1 file changed, 2 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-numeric-number (HEAD c0c087a)
 1 file changed, 2 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-numeric-bigint (HEAD c0c087a)
 1 file changed, 2 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-bigint-number (HEAD c0c087a)
 1 file changed, 2 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-timestamp-no-tz (HEAD c0c087a)
 1 file changed, 1 insertion(+)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M5-customType (HEAD c0c087a)
 1 file changed, 7 insertions(+), 1 deletion(-)
$ pnpm vitest run test/unit/db/schema-scan.spec.ts
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned column in the table metadata
 FAIL  test/unit/db/schema-scan.spec.ts > the real schema follows the column conventions > has no banned form in any source that imports drizzle-orm/pg-core
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M6 (HEAD c0c087a)
 1 file changed, 9 insertions(+), 1 deletion(-)
$ pnpm test
 FAIL  test/unit/db/drizzle.spec.ts > only src/db/client.ts connects > no non-spec source under src/ contains setTypeParser
 Test Files  1 failed | 24 passed (25)
      Tests  1 failed | 557 passed (558)
exit=1
$ pnpm test:db test/db/round-trip.db-spec.ts
 FAIL  test/db/round-trip.db-spec.ts > a round trip through the client > numeric comes back as the identical string through Drizzle
 FAIL  test/db/round-trip.db-spec.ts > a round trip through the client > numeric comes back as the identical string through the raw pool
 Test Files  1 failed (1)
      Tests  2 failed | 10 passed (12)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M7 (HEAD c0c087a)
 1 file changed, 4 insertions(+)
$ pnpm test:db test/db/research-role.db-spec.ts
 FAIL  test/db/research-role.db-spec.ts > connected as research_reader with its documented password > INSERT on the marker table fails with 42501
 Test Files  1 failed (1)
      Tests  1 failed | 24 passed (25)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M8 (HEAD c0c087a)
 1 file changed, 1 insertion(+)
$ ./node_modules/.bin/vitest run   (not pnpm test: pnpm would install the changed package.json first)
 FAIL  test/unit/tooling/dependencies.spec.ts > D9: no Anthropic SDK and no exchange client in the dependency tree > package.json has none of them
 Test Files  1 failed | 24 passed (25)
      Tests  1 failed | 557 passed (558)
exit=1
reverted; git status --short:
(clean if nothing above)
=== M9 (HEAD c0c087a)
 1 file changed, 1 deletion(-)
$ pnpm test
 FAIL  test/unit/config/logging.spec.ts > value scrub: encoded passwords > scrubs every form of 'escaped characters'
 FAIL  test/unit/config/secrets.spec.ts > secretValues > returns every form of an encoded password, raw and JSON-escaped
 FAIL  test/unit/config/secrets.spec.ts > secretValues > uses the password as the URL parser normalizes it
 FAIL  test/unit/config/secrets.spec.ts > secretValues > JSON-escapes control characters in the decoded password
 FAIL  test/unit/db/client.spec.ts > the client's password is a scrubbed form (S0c review) > escaped characters: the client sends one of the scrubbed forms
 FAIL  test/unit/db/client.spec.ts > the client's password is a scrubbed form (S0c review) > mixed encoding: the client sends one of the scrubbed forms
 FAIL  test/unit/db/client.spec.ts > the client's password is a scrubbed form (S0c review) > holds for every DATABASE_URL that parseSettings accepts (2,000 runs)
 Test Files  3 failed | 22 passed (25)
      Tests  7 failed | 551 passed (558)
exit=1
reverted; git status --short:
(clean if nothing above)
```

## Criterion 35: a fresh clone in a path with a space, under `env -i`

The clone is `scratchpad/s0e fresh clone`, on branch `factory/005-database-client` at `c0c087a`, with no `node_modules` and no `.env`. Its compose project `s0efreshclone` was removed with its volume afterwards, along with the folder.

```
clone: scratchpad/s0e fresh clone
HEAD c0c087a on factory/005-database-client
.
..
.claude
.env.example
.git
.gitignore
.nvmrc
Autonomous_Claude_Crypto_Trading_Agent_MASTER_BUILD_PLAN.md
CLAUDE.md
Crypto Trading Agent Implementation.md
Makefile
SLICE_1_PLAN.md
docker-compose.yml
factory
local-trading-agent-backend
progress.md
research
tests.json
0
no .env
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make db-up
+ prettier 3.9.10
+ source-map-support 0.5.21
+ typescript 6.0.3
+ typescript-eslint 8.72.1
+ vite 8.3.7
+ vitest 4.1.12
Done in 750ms using pnpm v12.3.4
$ DOTENV_CONFIG_PATH=/dev/null drizzle-kit migrate
No config path provided, using default 'drizzle.config.ts'
Reading config file 'scratchpad/s0e fresh clone/local-trading-agent-backend/drizzle.config.ts'
Using 'pg' driver for database querying
[⣷] applying migrations...[✓] migrations applied successfully!
exit=0
```

```
$ docker compose ps
s0efreshclone s0efreshclone-postgres-1 Up 11 seconds (healthy) 127.0.0.1:55432->5432/tcp
-- migration rows:
1|b3cc75fa802f8a5b333c480eb0d77f3d2185602e108f36fb33d3ade3c6939413
2|3b0abb7ed6df905add415f514966343c2d61847e8b06e4d7b59e8245534c6a05
3|6d5e0c76b3486b482783dd4967cd1341d491b1ba5147c3b01e8fd764f5f0685d
4|64925bee9d00146f050dc6fa8030d271dcdd42eee576b85c9adfe601ae38dc52
-- journal entries:
4
-- marker rows (marker, xmin):
2cd71c71-c05c-4b06-959f-21b289f0aa4e|734
-- research_reader:
research_reader|t|f
```

```
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make db-up   (second run)
Using 'pg' driver for database querying
[⣷] applying migrations...[✓] migrations applied successfully!exit=0
-- marker rows (marker, xmin) after the second run:
2cd71c71-c05c-4b06-959f-21b289f0aa4e|734
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make test
 Test Files  25 passed (25)
      Tests  558 passed (558)
exit=0
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make lint
$ eslint src test
exit=0
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make typecheck
$ tsc --noEmit -p tsconfig.json
exit=0
```

## Criterion 36: the upgrade path

The scratch clone is `scratchpad/s0e upgrade clone` (compose project `s0eupgradeclone`). It was removed with its volume afterwards, along with the folder.

```
== 1. main
HEAD 9b2df85
$ make db-up
[⣷] applying migrations...[✓] migrations applied successfully!
exit=0
-- migration rows (id, hash, created_at):
1|b3cc75fa802f8a5b333c480eb0d77f3d2185602e108f36fb33d3ade3c6939413|1794241128437
-- volume created:
s0eupgradeclone_pgdata 2026-11-10T18:02:48Z
-- marker table:
```

```
== 2. the branch
HEAD c0c087a
$ make db-up
[⣷] applying migrations...[✓] migrations applied successfully!
exit=0
-- migration rows (id, hash, created_at):
1|b3cc75fa802f8a5b333c480eb0d77f3d2185602e108f36fb33d3ade3c6939413|1794241128437
2|3b0abb7ed6df905add415f514966343c2d61847e8b06e4d7b59e8245534c6a05|1794332031523
3|6d5e0c76b3486b482783dd4967cd1341d491b1ba5147c3b01e8fd764f5f0685d|1794332036537
4|64925bee9d00146f050dc6fa8030d271dcdd42eee576b85c9adfe601ae38dc52|1794332036867
-- marker rows (marker, xmin):
6102e077-4536-43ad-a699-0790e6044f7a|735
-- volume:
s0eupgradeclone_pgdata 2026-11-10T18:02:48Z
== 3. again
$ make db-up
[⣷] applying migrations...[✓] migrations applied successfully!
exit=0
-- marker rows (marker, xmin):
6102e077-4536-43ad-a699-0790e6044f7a|735
4
```

```
== 4. build and boot with DATABASE_IDENTITY set to the marker
$ pnpm build
$ tsc --noEmit -p tsconfig.json
exit=0
$ env -i PATH=... DATABASE_URL=<.env.example URL> TRADER_MODE=paper DATABASE_IDENTITY=6102e077-4536-43ad-a699-0790e6044f7a node dist/main.js
{"level":"info","time":"2026-11-10T18:03:17.273Z","correlationId":"110ace4f-17a1-4870-a010-ddad89541659","context":"Database","msg":"Database identity","status":"VERIFIED","marker":"6102e077-4536-43ad-a699-0790e6044f7a"}
{"level":"info","time":"2026-11-10T18:03:17.273Z","correlationId":"110ace4f-17a1-4870-a010-ddad89541659","context":"Bootstrap","msg":"Trader started","mode":"paper"}
exit=0
```

Row 1 keeps its hash and `created_at` from `main`, and rows 2 to 4 are added. The volume's creation time is the same before and after the upgrade, and the marker and its `xmin` are the same after the third `make db-up`.

## Criterion 37: the diff stays inside the job

```
HEAD c0c087a
$ git diff --name-status main...HEAD
M	.env.example
M	local-trading-agent-backend/src/app.controller.spec.ts
M	local-trading-agent-backend/src/app.module.ts
A	local-trading-agent-backend/src/config/boot-output.ts
M	local-trading-agent-backend/src/config/config.module.ts
M	local-trading-agent-backend/src/config/secrets.ts
M	local-trading-agent-backend/src/config/settings.ts
A	local-trading-agent-backend/src/db/client.ts
A	local-trading-agent-backend/src/db/db.module.ts
A	local-trading-agent-backend/src/db/identity.ts
A	local-trading-agent-backend/src/db/migrations/0001_database_identity.sql
A	local-trading-agent-backend/src/db/migrations/0002_database_identity_marker.sql
A	local-trading-agent-backend/src/db/migrations/0003_research_reader.sql
A	local-trading-agent-backend/src/db/migrations/meta/0001_snapshot.json
A	local-trading-agent-backend/src/db/migrations/meta/0002_snapshot.json
A	local-trading-agent-backend/src/db/migrations/meta/0003_snapshot.json
M	local-trading-agent-backend/src/db/migrations/meta/_journal.json
M	local-trading-agent-backend/src/db/schema.ts
M	local-trading-agent-backend/src/main.ts
M	local-trading-agent-backend/test/app.e2e-spec.ts
A	local-trading-agent-backend/test/database-boot.e2e-spec.ts
A	local-trading-agent-backend/test/db/client.db-spec.ts
A	local-trading-agent-backend/test/db/identity.db-spec.ts
M	local-trading-agent-backend/test/db/migrate.db-spec.ts
A	local-trading-agent-backend/test/db/research-role.db-spec.ts
A	local-trading-agent-backend/test/db/round-trip.db-spec.ts
A	local-trading-agent-backend/test/fixtures/database.ts
M	local-trading-agent-backend/test/fixtures/db.ts
A	local-trading-agent-backend/test/fixtures/main.ts
A	local-trading-agent-backend/test/fixtures/schema-scan.ts
M	local-trading-agent-backend/test/unit/config/app-logger.spec.ts
A	local-trading-agent-backend/test/unit/config/boot-output.spec.ts
M	local-trading-agent-backend/test/unit/config/config.module.spec.ts
M	local-trading-agent-backend/test/unit/config/settings.spec.ts
A	local-trading-agent-backend/test/unit/db/client.spec.ts
A	local-trading-agent-backend/test/unit/db/db-module.spec.ts
M	local-trading-agent-backend/test/unit/db/drizzle.spec.ts
A	local-trading-agent-backend/test/unit/db/identity.spec.ts
A	local-trading-agent-backend/test/unit/db/schema-scan.spec.ts
M	local-trading-agent-backend/test/unit/tooling/dependencies.spec.ts
M	local-trading-agent-backend/test/unit/tooling/repo-files.spec.ts
M	local-trading-agent-backend/test/unit/tooling/research.spec.ts
M	local-trading-agent-backend/vitest.config.e2e.ts
M	progress.md
M	research/README.md
M	tests.json
$ git diff --name-only main...HEAD | grep -E "^(factory|\.claude)/|^research/|^CLAUDE\.md$|PLAN|^Autonomous|^Crypto Trading|^docker-compose\.yml$|^Makefile$"
research/README.md
$ git diff --name-status --diff-filter=D main...HEAD
(none)
$ git diff main...HEAD -- local-trading-agent-backend/package.json local-trading-agent-backend/pnpm-lock.yaml local-trading-agent-backend/pnpm-workspace.yaml | wc -l
       0
-- tripwires on added lines of non-test, non-.md, non-lockfile files (gate regex):
(no tripwire hit if nothing above)
-- skip/only/todo/xit/fit in added test lines:
(none if nothing above)
```

`research/README.md` is the only path in that group; the spec allows it.

## Proposed `CLAUDE.md` text (for a human to apply)

The only line to change is the `pnpm test:e2e` comment in the command block:

```sh
pnpm test:e2e    # run pnpm build and make db-up first
```

## For the human (criterion 39)

1. **Read the protected changes.**
   - Every file under `local-trading-agent-backend/src/db/migrations/`:
     - `0001` is generated
     - `0002` is one `INSERT ... gen_random_uuid()`
     - `0003` is the role and grants
     - the three new snapshots and the journal are drizzle-kit's output
   - Everything changed under `src/config/`: `settings.ts` (the new key), `secrets.ts` (`databaseTarget`), `config.module.ts` (records the secret values) and the new `boot-output.ts`.
   - `.env.example` (one new line, `DATABASE_IDENTITY=`).
2. **Accept `research_reader`.** Its password `research-local-dev-only` is written in `0003_research_reader.sql` and `research/README.md`. The migrations create the role on whichever server they run against. That includes every throwaway server a test or a scratch clone migrates, and your main compose server on the next `make db-up`.
3. **Confirm the Open decisions:**
   - the third settings key
   - Postgres generates the marker
   - a failed connect fails the boot while identity problems are `UNKNOWN`
   - the fixed research password
   - the `_ms` suffix rule
   - `pnpm test:e2e` now needs the compose Postgres
4. **After the merge, in the main checkout:**
   1. Run `make db-up`, then run the app once: `cd local-trading-agent-backend && pnpm build && pnpm start:prod`.
   2. Run `docker compose ps` at the repo root and check that the main checkout's own project (named after the repo folder) is the one publishing `127.0.0.1:55432`.
   3. Copy `marker` from the `Database identity` line (a `warn` with `reason: not_configured`) into `DATABASE_IDENTITY=` in `.env`.
   4. Run the app again and check that the line says `VERIFIED` at `info`.
5. **Apply the `CLAUDE.md` text above.**

## For reviewers

1. **Nest calls the connection factory with `null` settings when the settings provider throws.** I found this while testing that refused settings never connect. `@nestjs/core` 12.4.2 still runs a dependent factory, passing `null` for the failed dependency, in production `NestFactory` and in `Test.createTestingModule` alike; a throwaway spy spec confirmed it. Before the guard, `databaseConfig(null)` died on a `TypeError` before any pool existed, so nothing ever connected. `db.module.ts` now refuses explicitly, `Promise.reject(...)` for a non-object, so a refused boot can never reach `connectDatabase`. The error that surfaces is still the `SettingsError`, and the e2e cases check that stderr names the key. `db-module.spec.ts` "never connects when the settings are refused" spies on the real factory's call.
2. **M8 fetched `ccxt` once.** My first M8 run used `pnpm test`. With `package.json` changed, pnpm 12 installed dependencies before running the script, and it downloaded `ccxt@4.5.92` and `bufferutil@4.1.0` into this worktree's `node_modules`. Their build scripts were not run: pnpm reported `ERR_PNPM_IGNORED_BUILDS`, because `allowBuilds` denies them. The lockfile was reverted with the mutation. I then deleted `node_modules` and reinstalled with `pnpm install --frozen-lockfile --offline`, and checked that no `ccxt` or `bufferutil` remains. The tarballs are still in the user's global pnpm store as cache; I did not prune the user's store. The M8 evidence above runs `./node_modules/.bin/vitest run` instead, which installs nothing.
3. **Unit tests that boot `AppModule` substitute `connectDatabase` with `vi.mock`.** These are `app.controller.spec.ts`, `config.module.spec.ts` and `app-logger.spec.ts`, and they use `test/fixtures/database.ts`. The spec's example is `Test.createTestingModule(...).overrideProvider(...)`, but `@nestjs/testing` has no `bufferLogs`. `app-logger.spec.ts` must boot exactly as `main.ts` does to prove that buffered boot lines are scrubbed, so a module mock keeps `NestFactory.createApplicationContext` unchanged in all three. `db-module.spec.ts` also shows `overrideProvider(DATABASE_CONNECTION)` working. Production code has no switch.
4. **The client pins more than the five named variables.**
   - It also sets `ssl: false`, `sslnegotiation: 'postgres'`, `client_encoding: 'utf8'`, `application_name`, `replication: 'false'` (a normal session, which Postgres accepts) and `options: '-c TimeZone=UTC'`, so `PGSSLMODE`, `PGSSLNEGOTIATION`, `PGCLIENT_ENCODING`, `PGAPPNAME`, `PGREPLICATION` and `PGOPTIONS` are not read either.
   - `TimeZone=UTC` also makes the session UTC whatever the server says (D12). It does not change how instants round-trip, and criterion 21 runs with it.
   - Not pinned:
     - `PGBINARY`: read into `connectionParameters` but used only by the native client. The JS client reads `config.binary`.
     - `NODE_PG_FORCE_NATIVE`: it would make `pg` load `pg-native`, which is not installed, so the import fails loudly.
     - `USER`: `pg`'s module default, which is not used because the user is always set.
5. **Edge choices in `databaseConfig`.**
   - **Port 0** goes in as the text `'0'` with an `as number` cast, because `pg` treats a falsy port as unset and reads `PGPORT`.
   - **The query string and fragment are ignored.** That is safer than `pg`'s behaviour, but a setting such as `?sslmode=require` now has no effect, silently. Slice 1 runs on loopback only. Refusing it in `parseSettings` would be a settings change, which I left out.
   - **A URL with no user** uses `os.userInfo().username`, as libpq does. `userInfo()` throws on a uid with no passwd entry, which would fail the boot loudly.
6. **The research role.**
   - Memberships granted by hand to a `research_reader` that already existed are not revoked. Criterion 15 checks the role the migration creates.
   - `PUBLIC` still has `TEMP` on each database, so the role can create temporary tables. It has no `CREATE` on any schema.
   - The role exists on every compose server the tests migrate, which is by design.
7. **The schema scan** covers the spec's forms. It does not treat `bigserial({ mode: 'number' })`, `integer` or `smallint` as money. A later job could extend it if a money column ever uses one.
8. **Runtime output stays out of scope** and is recorded in `progress.md` for S11a and S12: a pool `error` event or an uncaught error after a successful boot is printed by Node without the scrub.
9. **Before the merge, the setup steps in `progress.md` and the `research_reader` sentence about the main server are prospective.** `progress.md` also says "S0 is complete", which is true once this job merges.
10. **Formatting.** Prettier is not part of `pnpm lint`. Every changed `.ts` file passes `prettier --check`.
