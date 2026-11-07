# S0a Repo foundation

## Goal

Replace the Nest HTTP scaffold with the base every later job builds on: a standalone Nest application context with no HTTP server and no telemetry, zod settings that accept only paper mode, structured JSON logs with correlation IDs, Node 26 and strict TypeScript tooling, and the repo-level files (`Makefile`, `.env.example`, `progress.md`, `tests.json`).

This job contains no trading logic.

## Plan references

- `SLICE_1_PLAN.md`: §1 (only secret), §2 Ops row (no HTTP controllers), D1, D2, D11, D12, D13, §4 module layout, §5 preamble, §5 S0.
- Master plan Part I: §32 (no secrets in logs).
- Master plan Part II: §2 (top-level files), §3 (environment, narrowed by S0), §24 preamble and Phases 1, 2 and 4.
- `CLAUDE.md`: "Known gaps between plan and repo".
- `factory/backlog.md`: item S0a. Item S0b owns the rest of S0.

## Scope

### In

**Node and TypeScript**
- `.nvmrc` at the repo root. nvm walks up from the app folder, so it applies there too.
- `engines.node` in `package.json`.
- `tsconfig.json`: keep `strict`, add `noUncheckedIndexedAccess`, remove `strictPropertyInitialization: false`.
- A `typecheck` script that runs `tsc --noEmit` on `tsconfig.json`, which covers `src/`, `test/` and spec files.
- `pnpm build` runs `typecheck` first. The build config excludes spec files, and the gate runs `pnpm build` but not `pnpm typecheck`. Without this chain, nothing enforces types in tests.

**Linter**
- typescript-eslint with type-aware rules replaces oxlint. See "Where the plan and the repo disagree".
- Remove `.oxlintrc.json`, `oxlint` and `oxlint-tsgolint`. The script stays named `lint`, because the gate calls it.
- Prettier stays as configured. Add `eslint-config-prettier` so the two do not conflict.

**Repo-level files, at the repo root**
- `Makefile` with `test`, `lint` and `typecheck` targets. Each target works in a non-interactive shell (source `factory/env.sh` in the recipe) and installs dependencies itself on a clean checkout. The repo path contains spaces. macOS ships GNU Make 3.81, so `.ONESHELL` and newer features are not available.
- `.env.example` with only `ANTHROPIC_API_KEY`, `DATABASE_URL` and `TRADER_MODE=paper`.
- `progress.md`: current state, what is done, what is next, and the D1 and linter settlements.
- `tests.json`, in this shape:

```json
{ "tests": [ {
  "file": "local-trading-agent-backend/test/unit/config/settings.spec.ts",
  "milestone": "S0",
  "covers": "paper-only settings, no values in errors",
  "status": "passing"
} ] }
```

**Standalone context**
- `src/main.ts` calls `NestFactory.createApplicationContext`, logs one startup line, closes the context and exits. There is no long-running work yet, so the process ends by itself.
- `AppModule` has no controllers and no Observe module.
- Delete `src/app.controller.ts` and `src/app.service.ts`.
- Remove `@nestjs/observe`, `@nestjs/platform-express`, `supertest`, `@types/supertest` and `@types/express`.
- Remove the Observability section and the Observe resource link from the app `README.md`.

**Settings**
- `src/config/settings.ts`: a zod schema and a pure `parseSettings(env)` with no Nest dependency. The result keeps the env names as keys: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `TRADER_MODE`.
- `src/config/config.module.ts`: a Nest module that provides the parsed settings through DI.
- `TRADER_MODE` is `z.literal('paper')`, required, with no default.
- `src/` never opens `.env`. The `start*` scripts load `../.env` with the runtime's env-file option, and no dotenv dependency is added. Tests and factory agents therefore never touch `.env`.

**Logging**
- `pino` via `nestjs-pino` (D2), with options in `src/config/logging.ts`. `pino-http` arrives as a `nestjs-pino` peer dependency. It is allowed, and it opens no port.
- Nest's own logger is routed through pino, so boot lines are JSON too.
- `src/shared/correlation.ts`: an `AsyncLocalStorage` scope helper with no Nest dependency. `main.ts` runs boot inside a scope, so the helper has a real caller.

**Tests**
- New tests go under `test/unit/` (§4).
- The two scaffold test files stay at their paths and are rewritten. See below.

### Where the plan and the repo disagree

**D1, app location. Decision: the app stays in `local-trading-agent-backend/`.**
- The plan's intent holds: this folder is the git root, and there is no `crypto-trading-agent/` wrapper. The §4 tree sits inside the app folder rather than directly at the root. That is a departure from the letter of §4.
- Moving the app in this job cannot work. `factory/gate.sh` runs `cd "$TREE/$APP" || exit 1` (line 49) from the main checkout, so after a move it exits 1 without writing `gate.md`. `/factory approve` refuses a nonzero gate, and `builder.md` forbids changing `factory/`.
- Moving the app would also weaken a safety check. The protected patterns `/src/risk/`, `/src/execution/`, `/src/claude/`, `/src/config/` and `/prompts/` need a leading slash, so at the repo root they would stop matching and risk code would lose human sign-off. `TEST_FILES` (line 20) is also tied to the app path.
- The settlement: files the master Part II §2 layout puts at the top level, other than app packaging, live at the repo root. That is `.nvmrc`, `Makefile`, `.env.example`, `progress.md`, `tests.json`, and from S0b `docker-compose.yml` and `research/`. The root `.gitignore` already expects `.env.example` there. `package.json`, tsconfig, the ESLint config, `src/` and `test/` stay in the app folder.
- Later jobs must keep `prompts/` and `scripts/` in the app folder as well, because `/prompts/` matches only there. `progress.md` records this.
- Moving the app later would be its own job, changing the gate in step, and is not planned.

**D2, linter. Decision: follow the plan, use typescript-eslint.** The slice plan outranks the scaffold. Type-aware linting is kept. `no-explicit-any` goes from `off` in `.oxlintrc.json` to error, which matches the repo's "no `any` escapes" review rule.

**D2, `strict`.** The scaffold's `strictPropertyInitialization: false` weakens strict mode, so it goes.

**`.env.example`.** Master Part II §3 lists Binance, Redis and news keys and calls the Claude key `CLAUDE_API_KEY`. S0 is stricter and wins: three keys, and the name `ANTHROPIC_API_KEY`.

**Correlation IDs.** The backlog text says "Structured JSON logging", while §5 S0 says "with correlation IDs". S0b does not cover them, so they are in this job.

**`make db-up`.** It is part of the S0 "Done when", but it needs `docker-compose.yml`, which S0b owns. The backlog applies a milestone's "Done when" when its last item merges. S0b adds the target, and this job adds no stub.

**Scaffold tests.** `src/app.controller.spec.ts` and `test/app.e2e-spec.ts` test HTTP behavior that D2 removes. The gate fails any deleted spec file, and approval cannot override a failing gate. They are rewritten in place to prove the replacement behavior, which is stronger than what they tested. The old assertions go because the behavior itself is removed on purpose, not to get to green.

**`CLAUDE.md`.** The gaps should be closed there, but `builder.md` forbids editing it. The builder writes the exact replacement text in `build.md` and a human applies it. Until then, the `# oxlint --type-aware` comment on line 17 is stale.

### Out

- `docker-compose.yml`, Drizzle, migrations, `make db-up`, `research/`: S0b.
- Any database connection. `DATABASE_URL` is validated only.
- `nest-commander`, the `trader` CLI, `launchd`, any long-running loop: S11.
- `@anthropic-ai/sdk` and any Claude code: S9.
- `RISK_POLICY.yaml`: S7a.
- `decimal.js`, `fast-check`, `@nestjs/event-emitter`, `@nestjs/schedule`: added by the first job that uses them.
- Master Phase 4 audit events: they need tables that later jobs own. Error classification: S0 does not list it and nothing calls it yet.
- Any change to `factory/`, `.claude/`, `CLAUDE.md`, `SLICE_1_PLAN.md` or the master plan.
- `@nestjs/mau` and the `deploy` script. They are not in this backlog item, so they stay.
- `@types/node` stays at 24 unless `typecheck` requires a bump.

### Stop conditions

Registry compatibility was not checked when this spec was written. If no `typescript-eslint` release supports TypeScript 6, or `nestjs-pino` will not work with Nest 12, stop and say so in `build.md`. Do not downgrade TypeScript or Nest, keep oxlint, or write a replacement logger. A peer-range warning that breaks neither install nor tests is not a stop, but note it in `build.md`.

### Gate constraints

- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint` and `pnpm build` must pass under those exact names. Commit `pnpm-lock.yaml`.
- The gate does not run `pnpm typecheck`, `pnpm test:e2e` or `make`. The builder runs them and pastes the results into `build.md`.
- Tripwires scan added lines in every file except test files, `.md` files and the lockfile. That includes `.env.example`, `tests.json`, `Makefile`, source comments and error messages. Those lines must not contain `sk-ant-`, a `BINANCE_KEY`-style name, or the word for the forbidden mode in quotes within 40 characters of `mode` or `TRADER_MODE`. So there is no key-prefix check in `settings.ts`, no placeholder key in `.env.example`, and no quoted mode name in `tests.json` descriptions. Test files may name these values to prove they are rejected.
- `.skip(`, `.only(`, `.todo(`, `xit(` and `fit(` fail the gate.
- Expect `NEEDS_HUMAN: yes`, because `src/config/` and `.env.example` are protected paths.

## Acceptance criteria

Each criterion is tagged with how it is proved:
- `unit` runs in `pnpm test`.
- `e2e` runs in `pnpm build && pnpm test:e2e`.
- `shell` is a command run in the worktree, with its output pasted into `build.md`. These are not vitest tests, because calling `make test` from vitest would recurse.

**Tooling**

1. `unit` `.nvmrc` at the repo root contains `26`, `engines.node` is `>=26.0.0 <27.0.0`, and the test process runs Node major version 26.
2. `unit` `tsconfig.json` has `strict: true` and `noUncheckedIndexedAccess: true`, and does not set `strictPropertyInitialization`.
3. `shell` `pnpm typecheck` exits 0. A spec file holds a `@ts-expect-error` on an unchecked index read assigned to `string`, so `typecheck` fails if the flag is ever removed.
4. `shell` A deliberate type error in a spec file makes both `pnpm typecheck` and `pnpm build` exit non-zero. The error is reverted afterwards.
5. `shell` From a fresh `git clone` into a path containing a space, with no `node_modules`, no `.env`, no `ANTHROPIC_API_KEY` in the environment, and a non-interactive shell with no node on `PATH`, `make test`, `make lint` and `make typecheck` each exit 0.
6. `shell` `pnpm lint` exits 0 and runs ESLint over `src/` and `test/`. A floating promise added to a file in `src/` makes it exit non-zero. The change is reverted afterwards.
7. `shell` `pnpm exec eslint --print-config src/main.ts` shows `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-explicit-any` at error severity.
8. `shell` `pnpm exec prettier --check "src/**/*.ts" "test/**/*.ts"` exits 0.
9. `unit` `.oxlintrc.json` does not exist, and `package.json` has neither `oxlint` nor `oxlint-tsgolint`.

**Repo-level files**

10. `unit` `.env.example` at the repo root has exactly the keys `ANTHROPIC_API_KEY`, `DATABASE_URL` and `TRADER_MODE`, with `TRADER_MODE=paper` and `ANTHROPIC_API_KEY` empty. These keys equal the settings schema keys. With a fixture key filled in, the file's values pass `parseSettings`.
11. `unit` `progress.md` at the repo root marks S0a done, names S0b as next, and records the D1 and linter settlements.
12. `unit` `tests.json` at the repo root is valid JSON in the shape above. Every listed file exists, and every `*.spec.ts` and `*.e2e-spec.ts` under `src/` and `test/` appears exactly once.

**Standalone context**

13. `unit` `src/main.ts` calls `createApplicationContext`. Non-spec files in `src/` contain none of `NestFactory.create(`, `.listen(`, `@Controller`, `AppController`, `AppService`.
14. `unit` `src/app.controller.spec.ts`, rewritten, boots `AppModule` and asserts that every module in the Nest container has zero controllers.
15. `e2e` `test/app.e2e-spec.ts`, rewritten, spawns `node dist/main.js` with fixture env and sees it exit 0 by itself within 10 seconds. A listener would hold the process open.
16. `unit` `package.json` has none of `@nestjs/observe`, `@nestjs/platform-express`, `supertest`, `@types/supertest`, `@types/express`. `pnpm-lock.yaml` has no `@nestjs/observe`. `src/`, `test/` (apart from this test) and the app `README.md` have no `OBSERVE_` or `@nestjs/observe`.
17. `shell` `git diff --name-status --diff-filter=D main...HEAD` lists no spec file, and both scaffold test files exist at their original paths.

**Settings**

18. `unit` `parseSettings` returns an object with exactly the three keys for valid input, and drops every other variable in the input, including `BINANCE_API_KEY`.
19. `unit` `parseSettings` rejects each of these for `TRADER_MODE`: `live`, `LIVE`, `Paper`, `PAPER`, `testnet`, `shadow`, ` paper`, the empty string, and unset. There is no default.
20. `unit` `expectTypeOf` proves `Settings['TRADER_MODE']` is exactly `'paper'`, and `src/config/settings.ts` does not contain the word `live`.
21. `unit` `parseSettings` rejects an unset, empty or whitespace-only `ANTHROPIC_API_KEY`. It applies no format or prefix check.
22. `unit` `parseSettings` accepts `postgres://` and `postgresql://` URLs. It rejects an unset value, a non-URL, `mysql://` and `postgresql+asyncpg://`.
23. `unit` For invalid input, the thrown error names every invalid key. Its `message`, `stack` and `JSON.stringify` output contain none of the input values, checked with sentinel strings in all three variables.
24. `unit` `parseSettings` reads only its argument. `settings.ts` imports nothing from `@nestjs/*`. Importing `src/app.module.ts` with an empty environment does not throw. `src/` contains neither `dotenv` nor `loadEnvFile`.
25. `unit` With valid env, the booted context returns the parsed settings through DI.
26. `unit` Every `start*` script in `package.json` loads `../.env`.
27. `e2e` `node dist/main.js` with `TRADER_MODE` set to a non-paper value exits non-zero, and a sentinel `ANTHROPIC_API_KEY` appears in neither stdout nor stderr.

**Logging**

28. `unit` `package.json` depends on `pino` and `nestjs-pino`.
29. `e2e` With valid fixture env, every stdout line from `node dist/main.js` parses as JSON and has `level`, `msg`, and `time` as an ISO-8601 UTC string ending in `Z`. This includes Nest's own boot lines.
30. `e2e` That output includes one startup line with `mode: paper` and a UUID `correlationId`, and contains neither fixture secret.
31. `unit` Logging `{ ANTHROPIC_API_KEY }`, `{ DATABASE_URL }`, `{ settings }`, or the settings object itself writes neither sentinel value. The redacted fields show `[REDACTED]`.
32. `unit` Inside a correlation scope, each log line carries that scope's `correlationId`, including after an `await`. Two concurrent scopes never see each other's ID. A scope with no explicit ID gets a generated UUID. A line logged outside any scope has no `correlationId`.
33. `unit` Non-spec files in `src/` contain no `console.` call.

**Job boundaries**

34. `shell` `git diff --name-only main...HEAD` lists nothing under `factory/` or `.claude/`, and does not list `CLAUDE.md`, `SLICE_1_PLAN.md` or the master plan.
35. `shell` `build.md` contains the exact proposed `CLAUDE.md` text: the lint comment, a `pnpm typecheck` entry, and the three "Known gaps" bullets closed.
36. `shell` `factory/gate.sh 001-repo-foundation` reports `GATE: PASS` and `NEEDS_HUMAN: yes`. The orchestrator runs this.
37. `[human]` A human confirms the D1 settlement (app stays in `local-trading-agent-backend/`) and the linter settlement, and applies the `CLAUDE.md` text from `build.md`.

## Rules that apply

- **No real orders and no Binance keys.** `TRADER_MODE` accepts only `paper`, and `live` is not implemented, not just disabled. So there is no enum member, branch or commented-out path for it. The only secret is `ANTHROPIC_API_KEY`.
- **Secrets never logged** (S0, master §32). The plan names one secret, but `DATABASE_URL` embeds a password, so it gets the same treatment in logs and errors.
- **Never delete or skip a test to go green.** See "Scaffold tests" above.
- **Invalid data is never silently used.** Invalid settings refuse the start.
- **UTC everywhere.** Log timestamps are UTC.
- **One implementation (D13).** `parseSettings` and the correlation helper stay free of Nest.
- **D11, crash loudly.** `main.ts` keeps its top-level `await`. Nothing swallows a startup failure, and any process-level error handler must exit non-zero.
- **Factory agents never read `.env`.** Tests use fixture values passed explicitly, never real ones.
- **ESM.** Relative imports end in `.js`.

The entry gate, the 48-entry limit, exits, EV and `Decimal` rules are not touched, because this job has no trading logic.

## Open decisions

None. No `SLICE_1_PLAN` §11 item affects this job.

The D1 and linter settlements under Scope are not §11 items. Criterion 37 puts them in front of a human, and the protected-path gate result sends this job to needs-human in any case.
