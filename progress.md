# Progress

Read this and `tests.json` at the start of every session (master Part II §24). Keep both current.

## Current state

The app is a standalone Nest application context in `local-trading-agent-backend/`. It has no HTTP server and no telemetry, and since S0d no HTTP adapter is installed either. It validates settings, connects to Postgres, checks which database it is talking to, logs one identity line and one startup line as structured JSON, closes the context and exits. It has no trading logic yet.

- Settings have three keys: `DATABASE_URL`, `TRADER_MODE` and the optional `DATABASE_IDENTITY`. The app loads no Anthropic credential (D9). `TRADER_MODE` accepts only `paper`. Invalid settings, including an unparseable `DATABASE_URL`, refuse the start without printing the value, and before any connection opens.
- Logs are JSON through `pino` and `nestjs-pino`, with UTC timestamps and a `correlationId` from `src/shared/correlation.ts`. Secrets are redacted by key path, and every line is also scrubbed by value: `src/config/secrets.ts` derives the loaded secret values from the settings (today the `DATABASE_URL` password, in each form it can be logged in), and a pino `hooks.streamWrite` replaces them with `[REDACTED]` wherever they appear. `AppModule` builds the logger from the settings parsed at boot.
- A fast-check property (`test/unit/config/secrets.property.spec.ts`) checks that every `DATABASE_URL` that `parseSettings` accepts also gets through `secretValues` and the logger options without throwing, so a zod upgrade cannot quietly turn a valid setting into a refused boot.
- A failed boot is loud and scrubbed. Two paths print outside pino, and both go through `scrubSecrets` with the values `ConfigModule` recorded from its one parse (`src/config/boot-output.ts`): Nest's own logger before `useLogger` (a `BootConsoleLogger` passed to `createApplicationContext`, which prints the `ExceptionHandler` line and the flushed boot lines), and `printBootFailure`, which replaces Node's printer for the rejected bootstrap in `src/main.ts`. The process exits 1, not by a signal, and stderr says what failed, with `[REDACTED]` where a secret was.
- Output after a successful boot is not covered yet: a pool `error` event or an uncaught error at run time is printed by Node without the scrub. S11a and S12 own runtime crash handling.
- `make test`, `make lint`, `make typecheck` and `make db-up` work from a clean checkout. These are the S0 "Done when" commands.

### Database

- `docker-compose.yml` at the repo root runs one service, Postgres 16.15, published on `127.0.0.1:55432` only, with its data in a named volume and the server time zone set to UTC. The credentials are fixed local-development values, and `.env.example` and the `Makefile` carry the same URL. The file has no interpolation and no `env_file`.
- The image is pinned by digest: `postgres:16.15@sha256:<index digest>`. The digest is the multi-platform image index of the official `docker.io/library/postgres` image, so the same line runs on arm64 and amd64 and every checkout gets the same bytes. To move to a newer 16.x release:
  1. Run `docker buildx imagetools inspect docker.io/library/postgres:16` and note the release (`org.opencontainers.image.version`) and the index `Digest` at the top, not a per-platform manifest digest.
  2. Write both into `image:` as `postgres:16.<minor>@sha256:<digest>`.
  3. Run `make db-up` and `pnpm test:db`.

  In an existing checkout, the next `make db-up` after the image line changes recreates the container on the pinned image and keeps the `pgdata` volume, so the data and the migration rows stay.
- `make db-up` finds Docker even when it is not on `PATH`, starts Postgres, waits until it is healthy, installs dependencies and runs `pnpm db:migrate` against the compose database. It is safe to run again, it never reads `.env`, and any failure exits non-zero.
  - Before starting Postgres it reads the image reference with `docker compose config --images` (S0g). When Docker already has that exact reference, it starts with `--pull never`, because a pull can hang in Docker's credential helper even for a local image. Otherwise it pulls as before, so a clean checkout still works. Compose's default policy is not enough on its own: it pulls a digest-pinned image whose local tag differs. A failed, empty or multi-word read stops the target with a `db-up:` message.
- Drizzle lives in the app folder: `drizzle.config.ts`, `src/db/schema.ts` (the identity marker table only) and `src/db/migrations/` (protected by the gate): the empty `0000_init`, the marker table, the marker row, and the research role.
- `pnpm db:generate` runs `drizzle-kit generate`. `pnpm db:migrate` applies the committed migrations to the database named by `DATABASE_URL` in the process environment, and fails when it is unset. Both set `DOTENV_CONFIG_PATH=/dev/null`, because drizzle-kit otherwise loads a `.env` from its working directory. No script uses `drizzle-kit push`.
- `pnpm test:db` runs `test/**/*.db-spec.ts` against the compose Postgres. Each test works in a throwaway `trader_test_*` database and drops it afterwards; a guard in `test/fixtures/db.ts` refuses any other name. `pnpm test` collects no DB spec and needs no database: unit tests that boot `AppModule` substitute the connection on the test side. `pnpm test:e2e` now needs `make db-up`, because a successful boot needs a migrated database; its cases run on throwaway databases too.
- **The connection.** `src/db/client.ts` is the only file under `src/` that opens a connection. `DbModule` (`src/db/db.module.ts`) builds a `pg` pool and a Drizzle instance from the parsed settings while the context is created, proves one connection, and ends the pool when the context closes.
  - Every field `pg` would otherwise take from the environment (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGOPTIONS`, `PGSSLMODE` and the rest) is set from `DATABASE_URL`, with the libpq defaults where the URL is silent: port 5432, the operating-system user, and a database named after the user. The query string is ignored.
  - The URL is parsed by the same WHATWG parser as `secretValues`, not by `pg`'s own parser, so the password the client sends is always one of the scrubbed forms.
  - The connect timeout is 5 seconds. One failed connect fails the boot, with no retry (D11, Rule 9), and `launchd` restarts the process.
  - No type parser changes: `numeric` and `int8` stay strings, and `timestamptz` keeps the driver's parsing.
- **The identity check.** Every checkout publishes Postgres on `127.0.0.1:55432`, so a leftover worktree database or an empty volume after a folder rename can answer in place of the real one, where the 48-entry counter reads 0 and a latched kill switch is missing. Each database carries a marker in `database_identity`: a UUID that Postgres generates with `gen_random_uuid()` the first time the database is migrated. The table holds at most one row, and the app never writes it, creates it or runs migrations.
  - At boot the app compares the marker with `DATABASE_IDENTITY`, exactly. The result is `VERIFIED` only on a match. Anything else is `UNKNOWN`, with one of four reasons: `not_configured` (the setting is unset or blank), `missing_marker` (no table, or no row), `mismatch` (any difference, case and whitespace included) or `unreadable` (any other failure after the connection opened).
  - `UNKNOWN` never fails the boot, so exits keep running. `blocksEntries` in `src/db/identity.ts` is the pure predicate for S7a: every `UNKNOWN` blocks entries.
  - Boot logs one identity line before the startup line: `info` for `VERIFIED`, `warn` for `UNKNOWN`, with the status, the reason and the stored marker.
  - An `unreadable` line carries `sqlstate` when the failed read had one (S0f): the error's `code`, only when it has the SQLSTATE shape `^[0-9A-Z]{5}$`. A Node error code, pg's read timeout, a malformed code and every other error field (message, detail, hint, stack) never reach the line, because a stand-in server controls them (Rule 11). `42P01` is still `missing_marker`, with no `sqlstate`.
  - The marker rows are checked with zod where they enter the app (`src/db/marker-rows.ts`, S0f). Rows that are not an array of objects each holding a string `marker` (a number, `NULL`, a missing key, ...) are a failed read, so `UNKNOWN` `unreadable` with no marker on the line, never a crash and never a coerced marker.
  - Setup, only for a database's first run: the first time the ledger database is created and migrated, and before any paper run has written to it. It is never a way to clear an `UNKNOWN`.
    1. Run `make db-up` in the main checkout, then run the app once.
    2. Read the stored marker from the identity line. On a first run it says `not_configured`.
    3. Run `docker compose ps` in that checkout and confirm that its own container is the one answering on the port.
    4. Set `DATABASE_IDENTITY` in `.env` to that marker, and run the app again to see `VERIFIED`.
  - After that first run, a `mismatch` or `missing_marker` is an incident, not a setup step (Rule 9: reconcile, verify, resume). The app may be talking to a stand-in: a leftover worktree database, or an empty volume after the folder was renamed, where the 48-entry counter reads 0 and the kill switch is missing. Every setup step above passes on such a stand-in too. Find the original volume and its container, and confirm the ledger before touching anything. **Never copy the marker printed on a `mismatch` line into `.env`, and never answer a `missing_marker` by migrating that database and copying its new marker:** either would pin the stand-in as the ledger.
- **The research role.** The migrations create `research_reader` on the server they run against, if it is missing, and set its attributes either way: `LOGIN` with a fixed local-development password written only in the migration and `research/README.md`, and no superuser, create-database, create-role, replication or bypass-RLS right. In each migrated database it gets `CONNECT`, `USAGE` on `public`, `SELECT` on every table in `public`, and default privileges so tables that `trader` creates later are readable too. It can write nothing and create nothing. `trader` stays the superuser that the app and `make db-up` use.
- **Column conventions,** enforced by a schema scan (`test/unit/db/schema-scan.spec.ts`) over the table metadata and the source text: money is `numeric` in its default string mode (no `real`, `doublePrecision`, or `numeric` in number or bigint mode), and time is `timestamptz` or epoch milliseconds in a number-mode `bigint` whose SQL name ends in `_ms`. No `customType`. A round trip under `TZ=Europe/Ljubljana` (`test/db/round-trip.db-spec.ts`) proves it.
  - Since S0f the metadata layer is an allow-list of Drizzle `columnType` values, so a type it does not know (`date`, `interval`, `point`, a type a drizzle-orm upgrade renames) fails it.
  - Integers: `integer`, `smallint`, `serial` and `smallserial` are allowed for counts and identifiers only, never for money or time, and never on an `_ms` name (32 bits cannot hold epoch milliseconds). `bigint` and `bigserial` outside `_ms` use bigint mode; a number-mode `bigserial` is banned. Through the raw pool an `int8` stays a string.
  - Arrays: only of `text`, `varchar`, `char`, `uuid`, `boolean` or an enum, at any nesting depth. A `numeric[]` keeps its exact strings through Drizzle, whose session replaces the array parser on its own queries, but comes back as JS numbers through the raw pool (`1.1`, `-1e-8`), so it is banned.
  - JSON: `json` and `jsonb` are banned until a job needs one and defines how money inside stays a string, because `JSON.parse` turns any number inside into a JS `number`.
  - D12, µs against ms: a `timestamptz` the server fills (`.defaultNow()` or any `.default(...)`) must declare `precision` 0 to 3. `now()` stores microseconds and both JS read paths keep milliseconds, so `=` on a value read back misses the row. A `$defaultFn` is filled in JS and is exempt. One pinned exemption: `database_identity.created_at`, which nothing reads or compares; a stale exemption fails the scan.

### Research

`research/` at the repo root is the Python skeleton (D13): `pyproject.toml` for uv with Python 3.12 and no dependencies, `.python-version`, `uv.lock`, `notebooks/` and `reports/`. It is offline only and stays out of every TypeScript script, config and `make` target. `research/README.md` states the boundary, and says research connects only as `research_reader`, never as `trader`.

## Done

- [x] S0a Repo foundation
- [x] S0b Database: Postgres 16 in Docker, Drizzle with an empty first migration, `make db-up`, `pnpm test:db`, and the `research/` skeleton
- [x] S0c Settings and log redaction: `ANTHROPIC_API_KEY` removed from the settings and `.env.example` (D9), a value-based scrub of the loaded secrets on top of the key paths, and no password in a `DATABASE_URL` parse error
- [x] S0d Dependency cleanup: Express, `multer` and the rest of the HTTP adapter out of the installed tree, `@nestjs/mau` and the `deploy` script removed, a fresh lockfile, TypeScript pinned inside the typescript-eslint peer range, the esbuild advisory decided, the compose image pinned by digest, and a fast-check property for boot availability
- [x] S0e Database client: the first connection through `src/db/client.ts`, the database identity marker and its boot check, the `research_reader` role, the column conventions, scrubbed failed-boot output, the D9 dependency test
- [x] S0f Database client follow-ups: `sqlstate` on the `unreadable` identity line, a zod check on the marker rows, the value scrub before `util.inspect` on both failed-boot printers, the schema scan as an allow-list with the integer, array, `jsonb` and server-filled `precision` rules, and the raw-pool `int8` and D12 evidence
- [x] S0g Small fixes: `make db-up` starts with `--pull never` when the pinned image is already local, the identity property also draws failed reads that carry a `sqlstate`, and the `scrubbedForInspect` comment names its one called getter, an Error's own `stack`

## Next

- S1a Normalizer and validator: ms and µs timestamps (D12), duplicates, ordering, gaps, staleness, OHLC sanity, outliers, quarantine.

S0 is complete: S0a to S0g have merged, and every S0 "Done when" command works from a clean checkout.

## Settlements

### D1, app location

The app stays in `local-trading-agent-backend/`. This departs from the letter of the slice plan's D1 and §4, whose tree sits directly at the root. The intent holds: the folder is the git root, with no `crypto-trading-agent/` wrapper.

Moving the app would break `factory/gate.sh`, which runs inside that folder, and would stop the protected patterns from matching, so risk code would lose human sign-off.

- Files that master Part II §2 puts at the top level, other than app packaging, live at the repo root: `.nvmrc`, `Makefile`, `.env.example`, `progress.md`, `tests.json`, `docker-compose.yml` and `research/`.
- `package.json`, tsconfig, the ESLint config, `drizzle.config.ts`, `src/` and `test/` stay in the app folder. So does `src/db/migrations/`, which the gate's protected pattern `/src/db/migrations/` matches.
- Later jobs must keep `prompts/` and `scripts/` in the app folder too, because the protected pattern `/prompts/` matches only there.
- Moving the app later would be its own job, changing the gate in step. It is not planned.

### Linter

typescript-eslint with type-aware rules replaces oxlint, following D2. `no-explicit-any` and `no-floating-promises` are errors. `eslint-config-prettier` keeps ESLint and Prettier from conflicting, and the script stays named `lint` because the gate calls it.

### Database

- S0 narrows master Phase 3 to the connection, the identity marker table and migration tests. Every table, index and enum from §7 and master §4 arrives with the job that first uses it.
- Number-mode `bigint` columns are allowed only for epoch milliseconds, recognised by an SQL name ending in `_ms`. A scan cannot tell a money column from a time column, so the name carries the rule.
- `docker-compose.yml` has no fixed `name:`. A fixed name would share one volume across every checkout, so a scratch clone's `down -v` would delete the real paper-run data. The identity marker is the defence instead.
- Python packaging stays inside `research/`, so there is no root `pyproject.toml` and no `research/datasets/`. Research reads from Postgres.

### Dependencies

S0d settled the dependency tree. `pnpm audit --prod` reports no advisory.

- **Removed.**
  - `@nestjs/platform-express`, `express`, `multer`, `cors` and everything only they pulled in. The lockfile held them only as a stale resolution of `@nestjs/core`'s optional peer, which pnpm does not install on a fresh resolution. Resolving `@nestjs/platform-express` from `@nestjs/core` now fails, so a future `NestFactory.create` fails loudly instead of finding an HTTP adapter. D2 has no HTTP server in slice 1; W2 brings HTTP back in its own job.
  - `@nestjs/mau`, the `deploy` script (`nest deploy`) and the app README's Deployment text. Slice 1 is local only (§2 Ops). They caused 23 of the 26 advisories on `main` (21 `undici`, 2 `tmp`).
- **Added.** `fast-check`, as a devDependency (D2). It is the only direct addition.
- **New transitive package.** `@isaacs/nonrecursive-glob-match` is a transitive dev package that came in through `@nestjs/cli` 12.0.12 and its `minimatch` 11. minimatch's author publishes it, and it has no install script that pnpm runs.
- **D9 is a unit test.** `test/unit/tooling/dependencies.spec.ts` fails if the Anthropic SDK or an exchange client package appears in any dependency section of `package.json` or among the `pnpm-lock.yaml` packages.
- **Lockfile.** `pnpm-lock.yaml` is a fresh resolution of `package.json` and `pnpm-workspace.yaml`, not an edit of the old one. Nest moved from 12.2 to 12.4. pnpm 12 skips versions published in the last day, and S0d left that setting alone.
- **TypeScript pin.** `typescript` is `~6.0.3`, not `^6.0.2`. typescript-eslint 8.72 declares the peer range `typescript >=4.8.4 <6.1.0`, and a caret range would let a refresh move TypeScript to 6.1 outside it. Raise the pin only to a version that the locked typescript-eslint declares.
- **Install scripts stay off.** `pnpm-workspace.yaml` denies every build script (`allowBuilds`, each `false`). The fresh resolution brought in no new package with a lifecycle script; esbuild is still the only one, and it runs without its postinstall.
- **esbuild, GHSA-67mh-4wv8-2f99.** esbuild is overridden. drizzle-kit depends on `@esbuild-kit/esm-loader`, whose `@esbuild-kit/core-utils` pinned `esbuild@0.18.20`, which the advisory covers (before 0.25.0, any website can read esbuild's dev server responses). `pnpm-workspace.yaml` overrides only that edge, `@esbuild-kit/core-utils>esbuild`, to `^0.25.4`, the range drizzle-kit itself uses. The lockfile now holds only esbuild 0.25.12 (drizzle-kit) and 0.28.2 (tsx and vite), so no new esbuild version entered. Bare `esbuild` is never overridden, because that would move the tsx and vite copies too. drizzle-kit's own CLI loads `drizzle.config.ts` through its bundled tsx, not through `@esbuild-kit`. `pnpm db:generate`, `pnpm test:db`, `make db-up` and `migrate-env.spec.ts` all pass under the override.
  - **Fallback**, if a later drizzle-kit breaks under it: drop the override and keep `esbuild@0.18.20`. The advisory covers only esbuild's dev server, which `serve` starts. Nothing in the repo calls `serve`, and the package is dev-only. Record what failed.
- **Advisories that remain.** `pnpm audit` reports one, dev-only:

  | Package | Version | Advisory | Severity | Path | Why it stays |
  |---|---|---|---|---|---|
  | `minimatch` | 10.2.6 | GHSA-g3hv-75wg-m249 (glob pattern amplification) | moderate | `eslint>minimatch`, `eslint>@eslint/config-array>minimatch`, `typescript-eslint>@typescript-eslint/typescript-estree>minimatch` | Dev-only lint tooling. The fix is in minimatch 11, outside the `^10` ranges that eslint 10.14, `@eslint/config-array` 0.23 and `@typescript-eslint/typescript-estree` 8.72 declare, and 10.2.6 is the newest 10.x. The patterns come only from the committed ESLint config and the `eslint src test` arguments, never from outside input. Revisit when eslint moves to minimatch 11. |

### Hand-offs from S0e

- **S7a** must treat an identity `UNKNOWN` (`blocksEntries` in `src/db/identity.ts`, provided through DI as `IDENTITY`) as a hard entry check, and decide whether it also counts as `kill_on_database_integrity_failure` (§8).
- **S7b**: the 48-entry counter and the kill switch must never read an unverified database as "zero entries" or "kill switch off".
- **S11a and S12** own the identity re-check after boot (for example when the pool reconnects to a different server), runtime crash handling, and scrubbed output after a successful boot: a pool `error` event or an uncaught run-time error is still printed by Node without the scrub.

### Other

- `strictPropertyInitialization: false` is gone, and `noUncheckedIndexedAccess` is on.
- `pnpm build` runs `pnpm typecheck` first. The build config excludes spec files, and the gate does not run `pnpm typecheck`, so this chain is what enforces types in tests.
- `.env.example` has three keys: `DATABASE_URL`, `TRADER_MODE=paper` and a blank `DATABASE_IDENTITY`. S0 is stricter than master Part II §3 and wins, and S0c removed `ANTHROPIC_API_KEY` per D9. S0e added the identity key, which is optional and not a secret; §5 S0 lists two keys, and a human confirms the third.
