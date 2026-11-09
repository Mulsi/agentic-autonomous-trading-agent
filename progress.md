# Progress

Read this and `tests.json` at the start of every session (master Part II §24). Keep both current.

## Current state

The app is a standalone Nest application context in `local-trading-agent-backend/`. It has no HTTP server and no telemetry. It validates settings, logs one startup line as structured JSON, closes the context and exits. It has no trading logic yet, and it does not connect to the database.

- Settings have two keys, `DATABASE_URL` and `TRADER_MODE`, and the app loads no Anthropic credential (D9). `TRADER_MODE` accepts only `paper`. Invalid settings, including an unparseable `DATABASE_URL`, refuse the start without printing the value.
- Logs are JSON through `pino` and `nestjs-pino`, with UTC timestamps and a `correlationId` from `src/shared/correlation.ts`. Secrets are redacted by key path, and every line is also scrubbed by value: `src/config/secrets.ts` derives the loaded secret values from the settings (today the `DATABASE_URL` password, in each form it can be logged in), and a pino `hooks.streamWrite` replaces them with `[REDACTED]` wherever they appear. `AppModule` builds the logger from the settings parsed at boot.
- Errors that Nest's default logger or Node print on a failed boot do not pass through pino. `scrubSecrets` is exported so S0e can apply it to them when it opens the first database connection.
- `make test`, `make lint`, `make typecheck` and `make db-up` work from a clean checkout. These are the S0 "Done when" commands.

### Database

- `docker-compose.yml` at the repo root runs one service, Postgres 16, published on `127.0.0.1:55432` only, with its data in a named volume and the server time zone set to UTC. The credentials are fixed local-development values, and `.env.example` and the `Makefile` carry the same URL. The file has no interpolation and no `env_file`.
- `make db-up` finds Docker even when it is not on `PATH`, starts Postgres, waits until it is healthy, installs dependencies and runs `pnpm db:migrate` against the compose database. It is safe to run again, it never reads `.env`, and any failure exits non-zero.
- Drizzle lives in the app folder: `drizzle.config.ts`, `src/db/schema.ts` (no tables yet) and `src/db/migrations/` (one empty migration, protected by the gate).
- `pnpm db:generate` runs `drizzle-kit generate`. `pnpm db:migrate` applies the committed migrations to the database named by `DATABASE_URL` in the process environment, and fails when it is unset. Both set `DOTENV_CONFIG_PATH=/dev/null`, because drizzle-kit otherwise loads a `.env` from its working directory. No script uses `drizzle-kit push`.
- `pnpm test:db` runs `test/**/*.db-spec.ts` against the compose Postgres. Each test works in a throwaway `trader_test_*` database and drops it afterwards; a guard in `test/fixtures/db.ts` refuses any other name. `pnpm test` and `pnpm test:e2e` collect no DB spec, so the gate needs no database.
- There is no database client in the app yet: no `src/db/client.ts`, no pool and no connection at boot. S0e adds one, now that S0c has merged.

### Research

`research/` at the repo root is the Python skeleton (D13): `pyproject.toml` for uv with Python 3.12 and no dependencies, `.python-version`, `uv.lock`, `notebooks/` and `reports/`. It is offline only and stays out of every TypeScript script, config and `make` target. `research/README.md` states the boundary.

## Done

- [x] S0a Repo foundation
- [x] S0b Database: Postgres 16 in Docker, Drizzle with an empty first migration, `make db-up`, `pnpm test:db`, and the `research/` skeleton
- [x] S0c Settings and log redaction: `ANTHROPIC_API_KEY` removed from the settings and `.env.example` (D9), a value-based scrub of the loaded secrets on top of the key paths, and no password in a `DATABASE_URL` parse error

## Next

- S0d Dependency cleanup: remove or justify the Express and `@nestjs/mau` advisory paths, re-resolve the lockfile, and pin the compose `postgres:16` image to a digest.

S0d remains open under S0, and so does S0e, the database client, which opens the first connection now that S0c has merged. S0b delivered the last S0 "Done when" command, but the milestone closes only when both have merged.

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

- S0 narrows master Phase 3 to an empty first migration. Every table, index and enum from §7 and master §4 arrives with the job that first uses it.
- Python packaging stays inside `research/`, so there is no root `pyproject.toml` and no `research/datasets/`. Research reads from Postgres.

### Other

- `strictPropertyInitialization: false` is gone, and `noUncheckedIndexedAccess` is on.
- `pnpm build` runs `pnpm typecheck` first. The build config excludes spec files, and the gate does not run `pnpm typecheck`, so this chain is what enforces types in tests.
- `.env.example` has two keys, `DATABASE_URL` and `TRADER_MODE=paper`. S0 is stricter than master Part II §3 and wins, and S0c removed `ANTHROPIC_API_KEY` per D9.
