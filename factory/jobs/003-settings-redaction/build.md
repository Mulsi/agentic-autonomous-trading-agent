# Build: 003-settings-redaction (S0c)

Branch `factory/003-settings-redaction`, three commits on `main` at `17f598c`. HEAD is `069d8c0`.

- `3fe28b8` S0c: drop ANTHROPIC_API_KEY from settings, scrub secrets by value
- `8047c88` S0c: prove the AppModule logger scrubs secrets in a unit test
- `069d8c0` S0c: prove AppModule parses the settings once at boot

At HEAD, `pnpm install --frozen-lockfile`, `pnpm test` (18 files, 308 tests), `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test:e2e` (20 tests) all exit 0. No stop condition was hit, and no `CLAUDE.md` text is proposed.

## What changed

**Settings (D9)**
- `src/config/settings.ts`: the schema has exactly `DATABASE_URL` and `TRADER_MODE`. The `ANTHROPIC_API_KEY` line is gone, replaced by a comment saying the app holds no Anthropic credential. Nothing else changed: `TRADER_MODE` is still `z.literal('paper')` with no default, the `DATABASE_URL` rule is the same, and `SettingsError` still carries key names only. The file still has no Nest import, no `process` access and no other-mode word.
- `.env.example`: the `ANTHROPIC_API_KEY=` line is removed. The other two lines are byte-identical.
- `docker-compose.yml`: comment line 5 only, which now reads `# only. They are not a secret; logs still scrub any DATABASE_URL password.`
- `test/fixtures/env.ts`: `fixtureEnv` has the two keys. `FIXTURE_API_KEY` stays as the Anthropic-key sentinel. `stubFixtureEnv()` also unsets `ANTHROPIC_API_KEY`, so a developer shell that holds one cannot change the unit results. `UNPARSEABLE_DATABASE_URLS` holds the three criterion-8 values, each with `FIXTURE_DB_PASSWORD` as the password (`<S>`).

**Value-based scrub**
- New `src/config/secrets.ts`. It is pure, with no `@nestjs/` import and no `process.`.
  - `secretValues(settings)` returns, longest first and without duplicates or empty strings: the URL as loaded, `url.password`, the decoded password (left out if `decodeURIComponent` throws), and the JSON-escaped form of each. It returns `[]` for no password or an empty one.
  - `scrubSecrets(text, values)` is exported. It replaces every occurrence of every value with `[REDACTED]`, longest first, and ignores `''`.
  - `REDACTED` is the shared censor string.
- `src/config/logging.ts`: `pinoOptions` is replaced by `loggerOptions(secrets)`. The options keep the same `base`, ISO timestamp, level formatter, `mixin` and key-path `redact` (same paths, same `[REDACTED]` censor), and add `hooks: { streamWrite: (line) => scrubSecrets(line, values) }`. The "Do not log these deeper" comment is rewritten to describe both layers and why `ANTHROPIC_API_KEY` stays as a defensive key path.
- `src/app.module.ts`: `LoggerModule.forRootAsync({ imports: [ConfigModule], inject: [SETTINGS], useFactory })` builds the options from the `SETTINGS` provider. Settings are parsed once, at boot, by the existing `ConfigModule` factory.

**Mechanism.** `hooks.streamWrite` passes through unchanged. `nestjs-pino` 5.3.1 hands `pinoHttp` to `pinoHttp(...)` (`rootLogger.js`), and `pino-http` 11 hands the remaining options to `pino(opts, stream)` (`logger.js:226`). Pino 10.4 applies the hook in `write()` (`lib/proto.js:243`) to every line, including those from child loggers. No fallback stream was needed.

**Repo files**
- `progress.md`:
  - S0c is marked done and S0d is named next.
  - "S0d remains open under S0, and so does S0e". S0e is listed under S0 in the backlog, so naming only S0d would be misleading.
  - "Current state" says settings have two keys and that logs are "scrubbed by value" on top of key paths, and no longer names the Anthropic key.
  - The settlement says `.env.example` has two keys.
  - The DB-client note now points at S0e.
- `tests.json`: two new entries (`secrets.spec.ts`, `app-logger.spec.ts`). `covers` is updated for every changed spec.

## Where `DATABASE_URL` is parsed under `src/` (criteria 9 and 10)

There is one explicit parse: **`src/config/secrets.ts`**, private `parseUrl()`, called only by `secretValues`. It is the only `new URL(` under `src/`. It returns `undefined` instead of throwing, and `passwordOf()` then throws `new SettingsError(['DATABASE_URL'])` **outside** the `catch`. The new error has no `input`, no `cause` and no part of the value. It never returns an empty list for a value it cannot parse.

Functions that parse `DATABASE_URL`, each called directly with the three unparseable values in tests:

| Function | How it parses | On an unparseable URL | Test |
|---|---|---|---|
| `parseSettings` (`src/config/settings.ts`) | zod `z.url`, which calls `new URL` inside zod. Zod's issue carries `input`, but `parseSettings` discards the whole zod error. | throws `SettingsError`: `invalidKeys` is `['DATABASE_URL']`, no `cause`, no `input` | `settings.spec.ts` "parseSettings: unparseable DATABASE_URL" |
| `secretValues` (`src/config/secrets.ts`) | `new URL` in `parseUrl` | throws `SettingsError(['DATABASE_URL'])`: no `input`, no `cause`, no `<S>` | `secrets.spec.ts` "secretValues: unparseable DATABASE_URL" |

Of the spec's two options, I chose to **throw** rather than treat the whole value as secret:
- It is D11 (crash loudly).
- It never yields an empty list, even for `''`.
- It never turns a whitespace-only value into a "secret" that would garble every line.

The throw cannot happen at boot. `parseSettings` runs first and accepts only strings that `new URL` parses (zod trims, then returns the trimmed string it parsed), so `secretValues` always gets a parseable URL from DI.

## Acceptance criteria

| # | Proof | Test or evidence |
|---|---|---|
| 1 | unit | `settings.spec.ts`: "returns exactly DATABASE_URL and TRADER_MODE" (keys of the result and of `settingsSchema.shape`), "types the settings as exactly the two keys" (`expectTypeOf<keyof Settings>`) |
| 2 | unit | `settings.spec.ts`: "succeeds and drops it when it is unset / empty / whitespace-only / a sentinel" (equals the result without the variable, no property, sentinel absent from `JSON.stringify`). "drops every other variable" includes `ANTHROPIC_API_KEY` and `BINANCE_API_KEY`. An extra test, "never reads it", uses a Proxy to show zod never reads the property. |
| 3 | unit | `config.module.spec.ts`: "boots with only DATABASE_URL and TRADER_MODE set" (key explicitly unset), "ignores ANTHROPIC_API_KEY in the environment (D9)" |
| 4 | e2e | `app.e2e-spec.ts`: "node dist/main.js with valid env" (env is `fixtureEnv`, two keys, asserted by "the valid env holds only DATABASE_URL and TRADER_MODE"). "node dist/main.js and ANTHROPIC_API_KEY (D9)": exits 0 with the sentinel set, and the sentinel is in neither stdout nor stderr. |
| 5 | unit | `repo-files.spec.ts` ".env.example": two keys equal to the schema keys, `TRADER_MODE=paper`, `parseSettings(example)` equals the file as is, `DATABASE_URL` equals the `main` value. `compose.spec.ts` credential tests still pass unchanged. |
| 6 | unit | `repo-files.spec.ts` "ANTHROPIC_API_KEY is gone (D9)": `docker-compose.yml`, `.env.example`, the "Current state" section, and non-spec `src/` files other than `src/config/logging.ts` (the list must equal exactly `['src/config/logging.ts']`) |
| 7 | shell | See "Criterion 7" below |
| 8 | unit | `settings.spec.ts` "parseSettings: unparseable DATABASE_URL": first asserts that `new URL` throws `ERR_INVALID_URL` with `input`. Then checks `invalidKeys`, `cause` undefined, no `input`, and `<S>` absent from `message`, `stack`, `JSON.stringify`, and `inspect(showHidden, depth null)`. |
| 9 | unit | `secrets.spec.ts` "secretValues: unparseable DATABASE_URL" (throws, no `input`, `cause` undefined, `<S>` absent from `message`, `stack` and `inspect`), plus criterion 8 for `parseSettings`. Both functions are named in the table above. |
| 10 | unit | `secrets.spec.ts` "source checks": files with `new URL(` equal `['src/config/secrets.ts']`, and files with `process.env` equal `['src/config/config.module.ts']` |
| 11 | e2e | `app.e2e-spec.ts` "node dist/main.js with an unparseable DATABASE_URL": each value exits non-zero and not null, stderr names `DATABASE_URL`, and `<S>` is in neither stream. A unit counterpart in `config.module.spec.ts` checks the boot rejection. |
| 12 | unit | `logging.spec.ts` "value scrub: nested more than one level deep" (three shapes, `[REDACTED]` at the exact path) |
| 13 | unit | `logging.spec.ts` "value scrub: key names outside the key-path list" (`apiKey`, `password`, `connectionString`, `dsn`) |
| 14 | unit | `logging.spec.ts` "value scrub: interpolated into the message" (URL template, password template, printf `%s`). Each `msg` is asserted exactly, with its prefix. |
| 15 | unit | `logging.spec.ts` "value scrub: errors and bindings" (`err.message` and `err.stack`, cause holding the password, `child({ conn: url })`) |
| 16 | unit | `logging.spec.ts` "value scrub: encoded passwords": all three URLs. Each listed form is logged in a message and under an unlisted key, checked clean in raw text and parsed values. Also covers "builds the logger options" (no throw, including `pa%zz`) and "the decoded form serializes with escaped characters". |
| 17 | unit | `logging.spec.ts` "value scrub: no secret, no change" (three URLs: `secretValues` is `[]`, `msg` unchanged, no `[REDACTED]`; and a password set with no secret form in the line). `secrets.spec.ts` "returns no values for ...". |
| 18 | unit | `logging.spec.ts` "secret redaction by key path". These use `loggerOptions([])`, so **only the key paths** can redact. They check exact `[REDACTED]` paths for `{ DATABASE_URL }`, `{ settings }`, the settings object, `{ config: settings }` and child `{ settings }`, that `TRADER_MODE` stays `paper`, and `{ ANTHROPIC_API_KEY: sentinel }`. "keeps the key paths when secret values are given too" checks both layers together. |
| 19 | unit | `logging.spec.ts` "through the nestjs-pino Logger": "scrubs one shape from each value-scrub case" (nested, `dsn`, `logger.log(message, context)` with the URL, `logger.error(Error, context)`), plus the existing "redacts through the Nest logger too" |
| 20 | e2e + unit | e2e: `app.e2e-spec.ts` "the built AppModule scrubs secret values from its logs". A child `node --input-type=module --eval` imports `dist/app.module.js`, boots as `main.ts` does, logs one shape each from 12 to 15 through the context's `Logger`, and closes. It must exit 0 with empty stderr, every stdout line must be clean JSON, `InstanceLoader` boot lines must be present, and `[REDACTED]` must sit at each spot. Unit: `app-logger.spec.ts` does the same against the real `AppModule` in-process, with no test-only switch in production code (see "For reviewers"). |
| 21 | unit | `secrets.spec.ts` "secrets.ts imports nothing from Nest and never touches process". `config.module.spec.ts` "does not throw with an empty environment" now also unsets `ANTHROPIC_API_KEY`. |
| 22 | shell | See "Criterion 22" below |
| 23 | e2e | The existing e2e cases pass with env inputs updated for D9. The "TRADER_MODE is unset" case now passes `{ DATABASE_URL }` only. |
| 24 | unit | `logging.spec.ts` "log line shape" and all of `correlation.spec.ts`. Same assertions, now on `loggerOptions(secretValues(parseSettings(fixtureEnv)))`. |
| 25 | unit | `repo-files.spec.ts` "progress.md": S0a, S0b and S0c done; S0d next and not done; "S0d remains open under S0"; "scrubbed by value" in Current state; "`.env.example` has two keys" |
| 26 | unit | `repo-files.spec.ts` "lists every spec file exactly once" (unchanged test, two new entries) |
| 27 | shell | See "Criterion 27" below |
| 28 | shell | See "Criterion 28" below |
| 29 | shell | Run by the orchestrator. I did not run `factory/gate.sh`, because it writes into `factory/`. Its checks are covered above: install, test, lint and build pass; a manual scan of the added non-test, non-`.md` lines with the gate's `TRIPWIRES` regex found nothing; and there is no `.skip(`, `.only(`, `.todo(`, `xit(` or `fit(`. Protected paths in the diff are `.env.example`, `src/config/logging.ts`, `src/config/secrets.ts` and `src/config/settings.ts`, so `NEEDS_HUMAN: yes` is expected. |
| 30 | [human] | Not provable by an agent. See "For the human" |

### Criterion 7: `vitest list test/unit/config/settings.spec.ts`, `main` (17f598c) vs branch

`main` lists 40 names and the branch lists 48.

```
--- names removed (on main, not on branch)
parseSettings: ANTHROPIC_API_KEY > applies no format or prefix check to "any-opaque-value"
parseSettings: ANTHROPIC_API_KEY > applies no format or prefix check to "no format check at all"
parseSettings: ANTHROPIC_API_KEY > applies no format or prefix check to "x"
parseSettings: ANTHROPIC_API_KEY > rejects blank value "   \t\n"
parseSettings: ANTHROPIC_API_KEY > rejects blank value " "
parseSettings: ANTHROPIC_API_KEY > rejects blank value ""
parseSettings: ANTHROPIC_API_KEY > rejects unset
parseSettings: valid input > returns exactly the three keys
--- names added (on branch, not on main)
parseSettings: ANTHROPIC_API_KEY is not a setting (D9) > never reads it
parseSettings: ANTHROPIC_API_KEY is not a setting (D9) > succeeds and drops it when it is a sentinel
parseSettings: ANTHROPIC_API_KEY is not a setting (D9) > succeeds and drops it when it is empty
parseSettings: ANTHROPIC_API_KEY is not a setting (D9) > succeeds and drops it when it is unset
parseSettings: ANTHROPIC_API_KEY is not a setting (D9) > succeeds and drops it when it is whitespace-only
parseSettings: unparseable DATABASE_URL > a port out of range makes new URL throw
parseSettings: unparseable DATABASE_URL > a port out of range: keeps the password out of every error surface
parseSettings: unparseable DATABASE_URL > a port out of range: throws a SettingsError that names only DATABASE_URL
parseSettings: unparseable DATABASE_URL > a space in the host makes new URL throw
parseSettings: unparseable DATABASE_URL > a space in the host: keeps the password out of every error surface
parseSettings: unparseable DATABASE_URL > a space in the host: throws a SettingsError that names only DATABASE_URL
parseSettings: unparseable DATABASE_URL > an unclosed IPv6 bracket makes new URL throw
parseSettings: unparseable DATABASE_URL > an unclosed IPv6 bracket: keeps the password out of every error surface
parseSettings: unparseable DATABASE_URL > an unclosed IPv6 bracket: throws a SettingsError that names only DATABASE_URL
parseSettings: valid input > returns exactly DATABASE_URL and TRADER_MODE
parseSettings: valid input > types the settings as exactly the two keys
```

(The `test/unit/config/settings.spec.ts > ` prefix is trimmed.)

**One name to look at.** Every `TRADER_MODE`, `DATABASE_URL`, error-content ("errors never carry values") and purity case is still present by name. One removed name is outside the `ANTHROPIC_API_KEY` block: "returns exactly the three keys". It is the "three-key expectation" the spec says to rewrite. It asserted the Anthropic key was one of three keys, which is D9-removed behaviour, and keeping the name would make it false. It is replaced by "returns exactly DATABASE_URL and TRADER_MODE".

Two error-content tests kept their names with D9 assertions:
- "names every invalid key in the message" now expects `['DATABASE_URL', 'TRADER_MODE']` and asserts that the blank Anthropic key is *not* named.
- The sentinel tests still pass an Anthropic sentinel as input and assert it never reaches the error.

### Criterion 22: mutation check (run at `069d8c0`, reverted, worktree confirmed clean)

```
HEAD 069d8c0
=== MUTATION 1: hooks.streamWrite deleted from loggerOptions, key paths kept
-    hooks: { streamWrite: (line) => scrubSecrets(line, values) },
pnpm test exit=1
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > is built from the settings parsed at boot
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > writes only clean lines, including the buffered boot lines
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > writes [REDACTED] where each secret was
 FAIL  test/unit/config/logging.spec.ts > value scrub: nested more than one level deep > scrubs { a: { b: settings } }
 FAIL  test/unit/config/logging.spec.ts > value scrub: nested more than one level deep > scrubs { a: { b: { c: settings } } }
 FAIL  test/unit/config/logging.spec.ts > value scrub: nested more than one level deep > scrubs { list: [settings] }
 FAIL  test/unit/config/logging.spec.ts > value scrub: key names outside the key-path list > scrubs { apiKey }
 FAIL  test/unit/config/logging.spec.ts > value scrub: key names outside the key-path list > scrubs { password }
 FAIL  test/unit/config/logging.spec.ts > value scrub: key names outside the key-path list > scrubs { connectionString }
 FAIL  test/unit/config/logging.spec.ts > value scrub: key names outside the key-path list > scrubs { dsn }
 FAIL  test/unit/config/logging.spec.ts > value scrub: interpolated into the message > scrubs a template string holding the URL
 FAIL  test/unit/config/logging.spec.ts > value scrub: interpolated into the message > scrubs a template string holding the password
 FAIL  test/unit/config/logging.spec.ts > value scrub: interpolated into the message > scrubs printf-style interpolation
 FAIL  test/unit/config/logging.spec.ts > value scrub: errors and bindings > scrubs an error message and stack that hold the URL
 FAIL  test/unit/config/logging.spec.ts > value scrub: errors and bindings > scrubs an error whose cause holds the password
 FAIL  test/unit/config/logging.spec.ts > value scrub: errors and bindings > scrubs child bindings that hold the URL
 FAIL  test/unit/config/logging.spec.ts > value scrub: encoded passwords > scrubs every form of 'escaped characters'
 FAIL  test/unit/config/logging.spec.ts > value scrub: encoded passwords > scrubs every form of 'mixed encoding'
 FAIL  test/unit/config/logging.spec.ts > value scrub: encoded passwords > scrubs every form of 'a password that does not decode'
 FAIL  test/unit/config/logging.spec.ts > through the nestjs-pino Logger > scrubs one shape from each value-scrub case
 Test Files  2 failed | 16 passed (18)
      Tests  20 failed | 288 passed (308)
pnpm build exit=0
pnpm test:e2e exit=1
 FAIL  test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes only clean JSON lines to stdout
 FAIL  test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes [REDACTED] where each secret was
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
reverted, git status:
(clean)

=== MUTATION 2: AppModule back to static options lacking the scrub
+  imports: [ConfigModule, LoggerModule.forRoot({ pinoHttp: loggerOptions([]) })],
pnpm test exit=1
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > is built from the settings parsed at boot
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > writes only clean lines, including the buffered boot lines
 FAIL  test/unit/config/app-logger.spec.ts > the AppModule logger > writes [REDACTED] where each secret was
 Test Files  1 failed | 17 passed (18)
      Tests  3 failed | 305 passed (308)
pnpm build exit=0
pnpm test:e2e exit=1
 FAIL  test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes only clean JSON lines to stdout
 FAIL  test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes [REDACTED] where each secret was
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
reverted, git status:
(clean)
```

Mutation 1 fails every test for criteria 12 to 16, plus 19 and 20. The key-path tests (18) and the no-change tests (17) still pass, as they should. Mutation 2 fails criterion 20 (e2e), and also the unit `app-logger.spec.ts`. After both reverts, `pnpm build` was rerun from the committed source before the final runs below.

### Criterion 27: `pnpm typecheck` and `pnpm build && pnpm test:e2e` (at `069d8c0`, clean worktree)

```
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Done in 29ms using pnpm v12.3.4
exit=0
$ pnpm test
 Test Files  18 passed (18)
      Tests  308 passed (308)
$ pnpm lint
$ eslint src test
exit=0
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json
exit=0
$ pnpm build && pnpm test:e2e
$ pnpm typecheck && nest build
$ tsc --noEmit -p tsconfig.json
$ vitest run --config ./vitest.config.e2e.ts
 Test Files  1 passed (1)
      Tests  20 passed (20)
exit=0
```

e2e, verbose:

```
 ✓ node dist/main.js with valid env > exits 0 by itself within the limit
 ✓ node dist/main.js with valid env > writes only JSON lines with level, msg and a UTC time
 ✓ node dist/main.js with valid env > routes Nest's own boot lines through pino
 ✓ node dist/main.js with valid env > logs one startup line with the mode and a UUID correlationId
 ✓ node dist/main.js with valid env > writes neither fixture secret
 ✓ node dist/main.js and ANTHROPIC_API_KEY (D9) > the valid env holds only DATABASE_URL and TRADER_MODE
 ✓ node dist/main.js and ANTHROPIC_API_KEY (D9) > exits 0 by itself when the environment holds a key
 ✓ node dist/main.js and ANTHROPIC_API_KEY (D9) > writes the key to neither stdout nor stderr
 ✓ node dist/main.js and the database > boots and exits 0 without connecting
 ✓ node dist/main.js with invalid env > refuses TRADER_MODE=live without leaking secrets
 ✓ node dist/main.js with invalid env > refuses TRADER_MODE=testnet without leaking secrets
 ✓ node dist/main.js with invalid env > refuses TRADER_MODE=PAPER without leaking secrets
 ✓ node dist/main.js with invalid env > refuses to start when TRADER_MODE is unset
 ✓ node dist/main.js with an unparseable DATABASE_URL > refuses a port out of range without leaking the password
 ✓ node dist/main.js with an unparseable DATABASE_URL > refuses an unclosed IPv6 bracket without leaking the password
 ✓ node dist/main.js with an unparseable DATABASE_URL > refuses a space in the host without leaking the password
 ✓ the built AppModule scrubs secret values from its logs > exits 0 with nothing on stderr
 ✓ the built AppModule scrubs secret values from its logs > writes only clean JSON lines to stdout
 ✓ the built AppModule scrubs secret values from its logs > passes Nest's buffered boot lines through the same logger
 ✓ the built AppModule scrubs secret values from its logs > writes [REDACTED] where each secret was
```

### Criterion 28: diff boundaries

```
$ git diff --name-status main...HEAD
M	.env.example
M	docker-compose.yml
M	local-trading-agent-backend/src/app.module.ts
M	local-trading-agent-backend/src/config/logging.ts
A	local-trading-agent-backend/src/config/secrets.ts
M	local-trading-agent-backend/src/config/settings.ts
M	local-trading-agent-backend/test/app.e2e-spec.ts
M	local-trading-agent-backend/test/fixtures/env.ts
A	local-trading-agent-backend/test/fixtures/logs.ts
A	local-trading-agent-backend/test/unit/config/app-logger.spec.ts
M	local-trading-agent-backend/test/unit/config/config.module.spec.ts
M	local-trading-agent-backend/test/unit/config/logging.spec.ts
A	local-trading-agent-backend/test/unit/config/secrets.spec.ts
M	local-trading-agent-backend/test/unit/config/settings.spec.ts
M	local-trading-agent-backend/test/unit/shared/correlation.spec.ts
M	local-trading-agent-backend/test/unit/tooling/repo-files.spec.ts
M	progress.md
M	tests.json
--- forbidden paths (factory/, .claude/, src/db/, research/, CLAUDE.md, plans)
(none)
$ git diff --name-status --diff-filter=D main...HEAD
(nothing)
$ git diff main...HEAD -- local-trading-agent-backend/package.json local-trading-agent-backend/pnpm-lock.yaml | wc -l
       0
```

## For the human (criterion 30)

1. **Read the protected changes:**
   - `src/config/settings.ts` (one schema line removed, one comment)
   - `src/config/secrets.ts` (new)
   - `src/config/logging.ts`
   - `.env.example` (one line removed)
2. **Confirm `ANTHROPIC_API_KEY` stays as a defensive key path only.** `ANTHROPIC_API_KEY` and `*.ANTHROPIC_API_KEY` in `SECRET_PATHS` load nothing. Settings drop the variable unread, and no other non-spec file under `src/` names it.
3. **Confirm that scrubbing errors printed outside pino at boot is left to S0e.**
   - On a failed boot, Nest's default logger (before `useLogger`) and Node's printer for the rejected top-level `await` write to stderr without the scrub. Today they print only `SettingsError: Invalid settings: DATABASE_URL` with `invalidKeys`; I ran it and saw no value.
   - `scrubSecrets` is exported for S0e.
4. **Optionally remove `ANTHROPIC_API_KEY` from your own `.env`.** The app now ignores it.

## For reviewers

**Gate gap closed by a unit test.** The gate runs `pnpm test`, not `pnpm test:e2e`, and with the e2e proof alone, mutation 2 (an `AppModule` built without the loaded secrets) still passed `pnpm test`. I added `test/unit/config/app-logger.spec.ts`:
- It boots the real `AppModule` once with `bufferLogs: true`, as `main.ts` does.
- It points the `nestjs-pino` root logger (`PinoLogger.root`, public) at a capture stream through `pino.symbols.streamSym`, a public export.
- It calls `useLogger` and checks every line, including the buffered `InstanceLoader` boot lines.
- It also reads the `PARAMS_PROVIDER_TOKEN` provider to check that the options' hook scrubs the loaded URL.
- It wraps the real `parseSettings` with `vi.mock` and asserts it ran once at boot.

Swapping the stream relies on pino reading `this[streamSym]` on each write. It is a test-side change only, with no switch in production code.

**Over-redaction with degenerate passwords** (measured against the built code; the spec accepts it, and no validation was added):

| Password in URL | Effect on `{"mode":"paper","msg":"Trader started"}` | Still JSON? |
|---|---|---|
| `a` | every `a` becomes `[REDACTED]` (`p[REDACTED]per`) | yes |
| `paper` / `info` | the `mode` or `level` value becomes `[REDACTED]` | yes |
| `R`, `ab`, `%5C` (`\`) | unchanged here; a one-character password that occurs inside `[REDACTED]` garbles markers written by a longer value | yes |
| `%22` (decoded `"`) | every `"` is replaced | **no** |
| `%3A` (decoded `:`) | every `:` is replaced | **no** |
| `%7B` (decoded `{`) | every `{` is replaced | **no** |

A leak never happens in these cases. Lines garble, and with JSON punctuation they stop being JSON. The compose password `local-dev-only` is unaffected.

**What the value scrub does not cover.** These are by design, per the spec's list of forms:
- A password with `"`, `\` or control characters that something JSON-encodes **twice** before logging, such as a stringified object logged as a string. Passwords without those characters survive any number of escapes unchanged, so they are still caught.
- In a mixed-encoding URL such as `mix@d%20<S>`, the password **as written** (`mix@d%20<S>`) logged on its own, outside the URL. The URL as loaded, the normalized form (`mix%40d%20<S>`, which also appears in `url.href`) and the decoded form (`mix@d <S>`, which is what `pg` uses) are all covered.
- Any other transformation, such as base64 or a substring.

**`nestjs-pino` singleton.** The root logger is per process: the first `LoggerModule` to build it wins (S0a `build.md`). A second `AppModule` boot in the same process, with different settings, would reuse the first boot's secret values. `main.ts` boots once. Test files that boot `AppModule` several times (`config.module.spec.ts`) all use the fixture URL.

**Other choices:**
- `scrubSecrets` dedupes and sorts the values on every call. That is at most 6 values per line, so it keeps the exported function order-independent at negligible cost.
- `secretValues(settings: Settings)` takes the whole settings object, so a later secret setting (§11 item 7) extends it in one place.
- The JSON-escaped form is `JSON.stringify(v).slice(1, -1)`. That matches both pino's `asString` for `msg` and the object serializer for `"`, `\` and control characters. A test covers `%09` (tab).
- The probe in the e2e criterion-20 test asserts `stderr === ''`. Pino's error serializer appends the cause message to `err.message` (`probe error [REDACTED]: cause [REDACTED]`), and the assertions match that.
- `test/fixtures/logs.ts` is a new shared fixture (`captureStream`, `stringsIn`, `expectClean`). "Clean" checks the raw line and every string in the parsed JSON, keys included.
- Prettier is not part of `pnpm lint`. All changed `.ts` files pass `prettier --check`.
