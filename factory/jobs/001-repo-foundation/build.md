# Build: 001-repo-foundation (S0a Repo foundation)

Branch `factory/001-repo-foundation`, commit `6102c80`. Nothing pushed; `main` untouched.

All builder checks pass: `pnpm install --frozen-lockfile`, `pnpm test` (94 tests in 9 files), `pnpm lint`, `pnpm build`, `pnpm typecheck` and `pnpm test:e2e` (9 tests) each exit 0.

**Waiting on others:** criterion 36 (the orchestrator runs the gate) and criterion 37 (a human confirms the settlements and applies the `CLAUDE.md` text below).

## Stop conditions

Neither was hit.

- **typescript-eslint on TypeScript 6:** 8.72.1 supports `typescript >=4.8.4 <6.1.0`. TypeScript is locked at 6.0.3.
- **nestjs-pino on Nest 12:** 5.3.1 supports `^11.0.8 || ^12.0.2`. Nest is locked at 12.2.0, and the standalone boot works in practice.
- `pnpm peers check` reports "No peer dependency issues found".

## What changed

**Tooling**
- `.nvmrc` (`26`) at the repo root, and `engines.node` set to `>=26.0.0 <27.0.0`.
- `tsconfig.json`: added `noUncheckedIndexedAccess`, removed `strictPropertyInitialization: false`.
- New `typecheck` script. `pnpm build` is now `pnpm typecheck && nest build`.
- `eslint.config.mjs` with typescript-eslint type-aware rules and `eslint-config-prettier`. `.oxlintrc.json`, `oxlint` and `oxlint-tsgolint` removed. `lint` is now `eslint src test`.

**Repo-level files:** `Makefile`, `.env.example`, `progress.md`, `tests.json`.

**App**
- `src/main.ts`: standalone context, one startup line, close, exit. Boot runs inside a correlation scope.
- `src/app.module.ts`: no controllers and no Observe module.
- `src/config/settings.ts`: zod schema, pure `parseSettings`, and `SettingsError`, which carries key names only.
- `src/config/config.module.ts`: provides parsed settings under the `SETTINGS` token, parsing at boot rather than at import.
- `src/config/logging.ts`: pino options (ISO UTC time, string level, redaction, correlation mixin).
- `src/shared/correlation.ts`: `AsyncLocalStorage` scope helper with no Nest dependency.
- Deleted `src/app.controller.ts` and `src/app.service.ts`.
- `start*` scripts load `../.env` with the runtime's env-file option.
- `README.md`: Observability section and Observe link removed, plus one new line saying the `start*` scripts load `../.env`.

**Dependencies:** added `zod`, `pino`, `nestjs-pino`, `pino-http`, and dev `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`. Removed everything the spec lists.

**Tests:** the two scaffold test files are rewritten in place. New specs are under `test/unit/`, with shared helpers in `test/fixtures/env.ts` and `test/fixtures/repo.ts`.

## Acceptance criteria

| # | Tag | Proof |
|---|---|---|
| 1 | unit | `test/unit/tooling/toolchain.spec.ts`: "pins Node 26 in .nvmrc and engines, and runs on it" |
| 2 | unit | `toolchain.spec.ts`: "is strict, with unchecked index access on", "does not weaken strict mode" |
| 3 | shell | Output below. The directive is in `toolchain.spec.ts`: "is enforced by typecheck on an unchecked index read" |
| 4 | shell | Output below |
| 5 | shell | Output below |
| 6 | shell | Output below |
| 7 | shell | Output below |
| 8 | shell | Output below |
| 9 | unit | `toolchain.spec.ts`: "has no oxlint left" |
| 10 | unit | `test/unit/tooling/repo-files.spec.ts`: `.env.example` block |
| 11 | unit | `repo-files.spec.ts`: `progress.md` block |
| 12 | unit | `repo-files.spec.ts`: `tests.json` block |
| 13 | unit | `test/unit/app/standalone.spec.ts` |
| 14 | unit | `src/app.controller.spec.ts`: "boots with zero controllers in every module" |
| 15 | e2e | `test/app.e2e-spec.ts`: "exits 0 by itself within the limit" |
| 16 | unit | `test/unit/app/no-telemetry.spec.ts` |
| 17 | shell | Output below |
| 18 | unit | `test/unit/config/settings.spec.ts`: "parseSettings: valid input" |
| 19 | unit | `settings.spec.ts`: "parseSettings: TRADER_MODE" |
| 20 | unit | `settings.spec.ts`: "types the mode as exactly the paper literal", "never names another mode in settings.ts" |
| 21 | unit | `settings.spec.ts`: "parseSettings: ANTHROPIC_API_KEY" |
| 22 | unit | `settings.spec.ts`: "parseSettings: DATABASE_URL" |
| 23 | unit | `settings.spec.ts`: "parseSettings: errors never carry values" |
| 24 | unit | `settings.spec.ts`: "parseSettings: purity"; `test/unit/config/config.module.spec.ts`: "does not throw with an empty environment" |
| 25 | unit | `config.module.spec.ts`: "returns the parsed settings through DI" |
| 26 | unit | `config.module.spec.ts`: "start scripts" block |
| 27 | e2e | `app.e2e-spec.ts`: "refuses TRADER_MODE=%s without leaking secrets" (`live`, `testnet`, `PAPER`), plus the unset case |
| 28 | unit | `test/unit/config/logging.spec.ts`: "logging dependencies" |
| 29 | e2e | `app.e2e-spec.ts`: "writes only JSON lines with level, msg and a UTC time", "routes Nest's own boot lines through pino" |
| 30 | e2e | `app.e2e-spec.ts`: "logs one startup line with the mode and a UUID correlationId", "writes neither fixture secret" |
| 31 | unit | `logging.spec.ts`: "secret redaction" block, including through the Nest logger |
| 32 | unit | `test/unit/shared/correlation.spec.ts` |
| 33 | unit | `logging.spec.ts`: "has no console call in non-spec source" |
| 34 | shell | Output below |
| 35 | shell | "Proposed CLAUDE.md text" below |
| 36 | shell | **Not run by the builder.** See below |
| 37 | human | **Not proved.** Needs a human |

Criterion 20's `expectTypeOf` does nothing at vitest runtime. Only `tsc` enforces it, which is why the `pnpm build` typecheck chain matters.

### Criterion 36: gate

The orchestrator runs this one. Running `gate.sh` from the worktree cannot work, because it resolves `ROOT` from its own location. I ran the gate's own regexes by hand against `main...HEAD`:

```text
tripwire hits: 0
skip hits: 0
deleted test files: 0
protected paths touched:
.env.example
local-trading-agent-backend/src/config/config.module.ts
local-trading-agent-backend/src/config/logging.ts
local-trading-agent-backend/src/config/settings.ts
```

Expected result: `GATE: PASS`, `NEEDS_HUMAN: yes`.

### Criterion 37: human

Please confirm the D1 settlement (the app stays in `local-trading-agent-backend/`) and the linter settlement (typescript-eslint replaces oxlint), then apply the `CLAUDE.md` text below. Until then, the `# oxlint --type-aware` comment in `CLAUDE.md` is stale.

## Shell output

Each deliberate break was reverted, and the worktree was confirmed clean afterwards.

### Criterion 3

```text
$ pnpm typecheck
exit=0

# with noUncheckedIndexedAccess removed from tsconfig.json
$ pnpm typecheck
test/unit/tooling/toolchain.spec.ts(34,5): error TS2578: Unused '@ts-expect-error' directive.
exit=2
dirty files after revert: 0
```

### Criterion 4

```text
# deliberate type error appended to test/unit/shared/correlation.spec.ts
$ pnpm typecheck
test/unit/shared/correlation.spec.ts(96,14): error TS2322: Type 'string' is not assignable to type 'number'.
typecheck exit=2
$ pnpm build
test/unit/shared/correlation.spec.ts(96,14): error TS2322: Type 'string' is not assignable to type 'number'.
build exit=1
dirty files after revert: 0
```

### Criterion 5

Each target ran in its own fresh clone, under `env -i HOME="$HOME" PATH=/usr/bin:/bin`, so each one had to install its own dependencies. Every clone path contains spaces. Tail of each run:

```text
### make test
path: .../scratchpad/clean room/clone test
commit: 6102c80  node_modules present: no  .env present: no
node on PATH: none  pnpm on PATH: none  ANTHROPIC_API_KEY: unset  interactive: no
 Test Files  9 passed (9)
      Tests  94 passed (94)
make exit=0

### make lint
path: .../scratchpad/clean room/clone lint
commit: 6102c80  node_modules present: no  .env present: no
node on PATH: none  pnpm on PATH: none  ANTHROPIC_API_KEY: unset  interactive: no
$ eslint src test
make exit=0

### make typecheck
path: .../scratchpad/clean room/clone typecheck
commit: 6102c80  node_modules present: no  .env present: no
node on PATH: none  pnpm on PATH: none  ANTHROPIC_API_KEY: unset  interactive: no
$ tsc --noEmit -p tsconfig.json
make exit=0
```

### Criterion 6

```text
$ pnpm lint
$ eslint src test
exit=0

# floating promise appended to src/shared/correlation.ts
$ pnpm lint
src/shared/correlation.ts
  20:1  error  Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the `void` operator  @typescript-eslint/no-floating-promises
✖ 1 problem (1 error, 0 warnings)
exit=1
dirty files after revert: 0
```

### Criterion 7

`--print-config` reports severity as a number, and `2` means error.

```text
@typescript-eslint/no-floating-promises [2]
@typescript-eslint/no-explicit-any [2]
```

### Criterion 8

```text
Checking formatting...
All matched files use Prettier code style!
exit=0
```

### Criterion 17

```text
$ git diff --name-status --diff-filter=D main...HEAD
D	local-trading-agent-backend/.oxlintrc.json
D	local-trading-agent-backend/src/app.controller.ts
D	local-trading-agent-backend/src/app.service.ts
(spec files in that list: 0)
local-trading-agent-backend/src/app.controller.spec.ts
local-trading-agent-backend/test/app.e2e-spec.ts
```

### Criterion 34

`git diff --name-only main...HEAD` filtered for `factory/`, `.claude/`, `CLAUDE.md`, `SLICE_1_PLAN.md` and both plan documents matched nothing (grep exit 1).

### Extra checks beyond the spec

- **`pnpm build && pnpm test:e2e` in a fresh clone:** both exit 0.
- **The e2e limit can really fail:** with `setInterval` injected into `dist/main.js`, "exits 0 by itself within the limit" failed after about 11 seconds.
- **`start` and `start:prod`** both booted and exited 0 with a fixture `../.env`. `start:dev` and `start:debug` were not run: they use `--watch`, so they never exit. A unit test confirms all four scripts carry the option.
- **Repeated builds:** three `pnpm build` runs in a row each left `dist/main.js` in place, so `deleteOutDir` with `incremental` is not emitting an empty `dist`.

The fixture `.env` was a throwaway with fake values, created and deleted inside a scratch clone. No real `.env` was read or touched.

## Proposed CLAUDE.md text

`CLAUDE.md` is off limits to the builder, so a human applies these two replacements.

**1. Replace the command block under "Layout and commands" with:**

```sh
pnpm install --frozen-lockfile
pnpm test        # vitest
pnpm lint        # eslint, type-aware
pnpm typecheck   # tsc --noEmit over src/, test/ and spec files
pnpm build       # typecheck, then nest build
pnpm test:e2e    # run pnpm build first
```

**2. Replace the whole "Known gaps between plan and repo" section with:**

```markdown
## Known gaps between plan and repo

Settled by S0a. `progress.md` has the detail.

- D1: the app stays in `local-trading-agent-backend/`, which departs from the letter of D1. Top-level files other than app packaging live at the repo root. `prompts/` and `scripts/` stay in the app folder, because the protected `/prompts/` pattern matches only there.
- D2, linter: typescript-eslint replaced oxlint. `pnpm typecheck` runs `tsc --noEmit`, and `pnpm build` runs it first.
- D2, standalone context: the HTTP listener, `AppController` and `@nestjs/observe` are gone. The app boots a standalone Nest application context.
```

## For reviewers

**Security: redaction is by key path, so it has limits.** Criterion 31's four shapes all pass, and so do one-level nesting under any key and child logger bindings. I ran the cases below against the real options, and all three write the secret in clear:

| Logged | Result |
|---|---|
| `{ a: settings }` | redacted |
| `{ a: { b: settings } }` (two levels deep) | **leaks** |
| `{ apiKey: value }` (a different key name) | **leaks** |
| `` `text ${value}` `` (interpolated into the message) | **leaks** |

All three follow from how pino's `redact` works: it matches key paths, so no path list can cover every depth, key name or message string. Today's code logs none of these shapes: the only app log call writes `mode`. Later jobs must not pass settings around in logged objects. `src/config/logging.ts` has a short comment saying so, but nothing enforces it.

**Failed boots are not JSON.** On invalid settings, Nest's default logger writes plain text, because pino only takes over once the context exists. The result is ANSI-coloured lines on stdout and the error printed twice, once by Nest and once by Node. Criterion 29 covers valid env only, so this meets the spec. The output holds only the sanitized `SettingsError`, and e2e criterion 27 confirms no secrets appear. It would matter if something later parses these logs as strict JSON.

**`DATABASE_URL` whitespace is trimmed, not rejected.** `z.url` strips surrounding whitespace, so `' postgresql://u@localhost/db '` passes and comes back trimmed. `TRADER_MODE` rejects ` paper`, so the two differ. I kept this because the spec does not cover it and the value handed on is clean.

**Upgrade trap.** `typescript` is `^6.0.2`, which permits 6.1 on a lockfile refresh, while typescript-eslint's peer range stops at `<6.1.0`. The lockfile holds 6.0.3 for now.

**Choices the spec left open**
- ESLint uses `recommendedTypeChecked`, not `strictTypeChecked`. That includes `no-explicit-any`, `no-floating-promises` and the `no-unsafe-*` family. Strict is a one-line change, but it also needs `no-extraneous-class` relaxed for Nest modules.
- `pino-http` is a direct dependency rather than relying on pnpm to auto-install the peer.
- `abortOnError: false` in `main.ts`, so a failed boot reaches the top-level `await` (D11) rather than Nest calling `process.exit(1)` itself.
- `DATABASE_URL` also requires a hostname, so a bare `postgres://` is rejected. The spec does not ask for this.
- The `.env.example` placeholder is `postgresql://trader:change-me@localhost:5432/trader`. S0b should align it with `docker-compose.yml`.

**Behaviour to know**
- With no `../.env`, `pnpm start` and `pnpm start:prod` both exit 9 (`node: ../.env: not found`). Environment variables alone will not get past these scripts. S11's `launchd` setup should run `node dist/main.js` directly or provide the file.
- `SETTINGS` is a `Symbol`, so a spec that calls `vi.resetModules()` and re-imports gets a different token. That caused one test failure during the build, now fixed.
- `nestjs-pino`'s root logger is a process-wide singleton: the first caller's options win. Specs that need a capture stream should use `pino(pinoOptions, stream)` directly, or expect only one `LoggerModule.forRoot` per test file.
