# Progress

Read this and `tests.json` at the start of every session (master Part II §24). Keep both current.

## Current state

The app is a standalone Nest application context in `local-trading-agent-backend/`. It has no HTTP server and no telemetry, and since S0d no HTTP adapter is installed either. It validates settings, logs one startup line as structured JSON, closes the context and exits. It has no trading logic yet, and it does not connect to the database.

- Settings have two keys, `DATABASE_URL` and `TRADER_MODE`, and the app loads no Anthropic credential (D9). `TRADER_MODE` accepts only `paper`. Invalid settings, including an unparseable `DATABASE_URL`, refuse the start without printing the value.
- Logs are JSON through `pino` and `nestjs-pino`, with UTC timestamps and a `correlationId` from `src/shared/correlation.ts`. Secrets are redacted by key path, and every line is also scrubbed by value: `src/config/secrets.ts` derives the loaded secret values from the settings (today the `DATABASE_URL` password, in each form it can be logged in), and a pino `hooks.streamWrite` replaces them with `[REDACTED]` wherever they appear. `AppModule` builds the logger from the settings parsed at boot.
- A fast-check property (`test/unit/config/secrets.property.spec.ts`) checks that every `DATABASE_URL` that `parseSettings` accepts also gets through `secretValues` and the logger options without throwing, so a zod upgrade cannot quietly turn a valid setting into a refused boot.
- Errors that Nest's default logger or Node print on a failed boot do not pass through pino. `scrubSecrets` is exported so S0e can apply it to them when it opens the first database connection.
- `make test`, `make lint`, `make typecheck` and `make db-up` work from a clean checkout. These are the S0 "Done when" commands.

### Database

- `docker-compose.yml` at the repo root runs one service, Postgres 16.15, published on `127.0.0.1:55432` only, with its data in a named volume and the server time zone set to UTC. The credentials are fixed local-development values, and `.env.example` and the `Makefile` carry the same URL. The file has no interpolation and no `env_file`.
- The image is pinned by digest: `postgres:16.15@sha256:<index digest>`. The digest is the multi-platform image index of the official `docker.io/library/postgres` image, so the same line runs on arm64 and amd64 and every checkout gets the same bytes. To move to a newer 16.x release:
  1. Run `docker buildx imagetools inspect docker.io/library/postgres:16` and note the release (`org.opencontainers.image.version`) and the index `Digest` at the top, not a per-platform manifest digest.
  2. Write both into `image:` as `postgres:16.<minor>@sha256:<digest>`.
  3. Run `make db-up` and `pnpm test:db`.

  In an existing checkout, the next `make db-up` after the image line changes recreates the container on the pinned image and keeps the `pgdata` volume, so the data and the migration rows stay.
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
- [x] S0d Dependency cleanup: Express, `multer` and the rest of the HTTP adapter out of the installed tree, `@nestjs/mau` and the `deploy` script removed, a fresh lockfile, TypeScript pinned inside the typescript-eslint peer range, the esbuild advisory decided, the compose image pinned by digest, and a fast-check property for boot availability

## Next

- S0e Database client: the first database connection, now that S0c has merged and S0d has cleaned up the dependencies.

S0e remains open under S0. S0b delivered the last S0 "Done when" command, but the milestone closes only when S0e has merged.

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

### Dependencies

S0d settled the dependency tree. `pnpm audit --prod` reports no advisory.

- **Removed.**
  - `@nestjs/platform-express`, `express`, `multer`, `cors` and everything only they pulled in. The lockfile held them only as a stale resolution of `@nestjs/core`'s optional peer, which pnpm does not install on a fresh resolution. Resolving `@nestjs/platform-express` from `@nestjs/core` now fails, so a future `NestFactory.create` fails loudly instead of finding an HTTP adapter. D2 has no HTTP server in slice 1; W2 brings HTTP back in its own job.
  - `@nestjs/mau`, the `deploy` script (`nest deploy`) and the app README's Deployment text. Slice 1 is local only (§2 Ops). They caused 23 of the 26 advisories on `main` (21 `undici`, 2 `tmp`).
- **Added.** `fast-check`, as a devDependency (D2). It is the only addition.
- **Lockfile.** `pnpm-lock.yaml` is a fresh resolution of `package.json` and `pnpm-workspace.yaml`, not an edit of the old one. Nest moved from 12.2 to 12.4. pnpm 12 skips versions published in the last day, and S0d left that setting alone.
- **TypeScript pin.** `typescript` is `~6.0.3`, not `^6.0.2`. typescript-eslint 8.72 declares the peer range `typescript >=4.8.4 <6.1.0`, and a caret range would let a refresh move TypeScript to 6.1 outside it. Raise the pin only to a version that the locked typescript-eslint declares.
- **Install scripts stay off.** `pnpm-workspace.yaml` denies every build script (`allowBuilds`, each `false`). The fresh resolution brought in no new package with a lifecycle script; esbuild is still the only one, and it runs without its postinstall.
- **esbuild, GHSA-67mh-4wv8-2f99.** esbuild is overridden. drizzle-kit depends on `@esbuild-kit/esm-loader`, whose `@esbuild-kit/core-utils` pinned `esbuild@0.18.20`, which the advisory covers (before 0.25.0, any website can read esbuild's dev server responses). `pnpm-workspace.yaml` overrides only that edge, `@esbuild-kit/core-utils>esbuild`, to `^0.25.4`, the range drizzle-kit itself uses. The lockfile now holds only esbuild 0.25.12 (drizzle-kit) and 0.28.2 (tsx and vite), so no new esbuild version entered. Bare `esbuild` is never overridden, because that would move the tsx and vite copies too. drizzle-kit's own CLI loads `drizzle.config.ts` through its bundled tsx, not through `@esbuild-kit`. `pnpm db:generate`, `pnpm test:db`, `make db-up` and `migrate-env.spec.ts` all pass under the override.
  - **Fallback**, if a later drizzle-kit breaks under it: drop the override and keep `esbuild@0.18.20`. The advisory covers only esbuild's dev server, which `serve` starts. Nothing in the repo calls `serve`, and the package is dev-only. Record what failed.
- **Advisories that remain.** `pnpm audit` reports one, dev-only:

  | Package | Version | Advisory | Severity | Path | Why it stays |
  |---|---|---|---|---|---|
  | `minimatch` | 10.2.6 | GHSA-g3hv-75wg-m249 (glob pattern amplification) | moderate | `eslint>minimatch`, `eslint>@eslint/config-array>minimatch`, `typescript-eslint>@typescript-eslint/typescript-estree>minimatch` | Dev-only lint tooling. The fix is in minimatch 11, outside the `^10` ranges that eslint 10.14, `@eslint/config-array` 0.23 and `@typescript-eslint/typescript-estree` 8.72 declare, and 10.2.6 is the newest 10.x. The patterns come only from the committed ESLint config and the `eslint src test` arguments, never from outside input. Revisit when eslint moves to minimatch 11. |

### Other

- `strictPropertyInitialization: false` is gone, and `noUncheckedIndexedAccess` is on.
- `pnpm build` runs `pnpm typecheck` first. The build config excludes spec files, and the gate does not run `pnpm typecheck`, so this chain is what enforces types in tests.
- `.env.example` has two keys, `DATABASE_URL` and `TRADER_MODE=paper`. S0 is stricter than master Part II §3 and wins, and S0c removed `ANTHROPIC_API_KEY` per D9.
