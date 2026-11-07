# Progress

Read this and `tests.json` at the start of every session (master Part II §24). Keep both current.

## Current state

The app is a standalone Nest application context in `local-trading-agent-backend/`. It has no HTTP server and no telemetry. It validates settings, logs one startup line as structured JSON, closes the context and exits. It has no trading logic yet.

- `TRADER_MODE` accepts only `paper`. Invalid settings refuse the start.
- Logs are JSON through `pino` and `nestjs-pino`. Timestamps are UTC, `ANTHROPIC_API_KEY` and `DATABASE_URL` are redacted, and `correlationId` comes from `src/shared/correlation.ts`.
- `make test`, `make lint` and `make typecheck` work from a clean checkout. `make db-up` does not exist yet: S0b adds it.

## Done

- [x] S0a Repo foundation

## Next

- S0b Database: `docker-compose.yml` with Postgres 16, Drizzle and drizzle-kit with an empty first migration, the `research/` uv skeleton, and the `make db-up` target. The S0 "Done when" applies once S0b merges.

## Settlements

### D1, app location

The app stays in `local-trading-agent-backend/`. This departs from the letter of the slice plan's D1 and §4, whose tree sits directly at the root. The intent holds: the folder is the git root, with no `crypto-trading-agent/` wrapper.

Moving the app would break `factory/gate.sh`, which runs inside that folder, and would stop the protected patterns from matching, so risk code would lose human sign-off.

- Files that master Part II §2 puts at the top level, other than app packaging, live at the repo root: `.nvmrc`, `Makefile`, `.env.example`, `progress.md`, `tests.json`, and from S0b `docker-compose.yml` and `research/`.
- `package.json`, tsconfig, the ESLint config, `src/` and `test/` stay in the app folder.
- Later jobs must keep `prompts/` and `scripts/` in the app folder too, because the protected pattern `/prompts/` matches only there.
- Moving the app later would be its own job, changing the gate in step. It is not planned.

### Linter

typescript-eslint with type-aware rules replaces oxlint, following D2. `no-explicit-any` and `no-floating-promises` are errors. `eslint-config-prettier` keeps ESLint and Prettier from conflicting, and the script stays named `lint` because the gate calls it.

### Other

- `strictPropertyInitialization: false` is gone, and `noUncheckedIndexedAccess` is on.
- `pnpm build` runs `pnpm typecheck` first. The build config excludes spec files, and the gate does not run `pnpm typecheck`, so this chain is what enforces types in tests.
- `.env.example` has three keys. S0 is stricter than master Part II §3 and wins.
