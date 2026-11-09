# S0c Settings and log redaction

## Goal

Feature text (`factory/backlog.md`, verbatim):

> - [ ] S0c Settings and log redaction (D9, S0a review): remove `ANTHROPIC_API_KEY` from `.env.example`, the zod settings and their tests, because the app holds no secrets now (D9). Then harden redaction: it matches key paths only, so a secret nested two levels deep, under another key name, or interpolated into a message is logged in clear. Add a value-based scrub of the loaded secret values, today the `DATABASE_URL` password (for example through pino `hooks.streamWrite`), on top of the key paths, with tests for those three shapes. An unparseable `DATABASE_URL` must not leak its password through the parse error, which Node's `URL` includes in full (S0b review). Must merge before the app first connects to the database. Touches `src/config/`, so it needs a human.

This job has two parts:

1. **Settings follow D9.** The app holds no Anthropic credential. `ANTHROPIC_API_KEY` leaves the zod settings, `.env.example`, the test fixtures and the settings tests, and boot no longer depends on any Claude configuration.
2. **No log line carries a loaded secret, whatever shape it is logged in.** Today `src/config/logging.ts` redacts by key path only, so the `DATABASE_URL` password is written in clear when it is nested two levels deep, logged under another key name, or interpolated into a message. This job adds a value-based scrub of the loaded secret values on top of the key paths. It also makes sure an unparseable `DATABASE_URL` cannot leak its password through Node's URL parse error.

S0e adds the first database connection and needs this job merged first. This job adds no trading logic and opens no database connection.

## Plan references

- `SLICE_1_PLAN.md` (revised 2026-11-09):
  - §1: no Anthropic API key, and the app holds no secrets.
  - D9: no `@anthropic-ai/sdk` and no `ANTHROPIC_API_KEY`, so the app never holds an Anthropic credential.
  - D11: crash loudly. The engine and exits run without Claude.
  - D14: positions are managed 24/7 without Claude.
  - §5 S0:
    - `.env.example` has only `DATABASE_URL` and `TRADER_MODE=paper`, and S0c removes `ANTHROPIC_API_KEY` per D9.
    - Secrets are never logged.
    - Logging is structured JSON.
  - §9:
    - The CLI runs under the user's own login, and the app never handles a credential.
    - The child process gets an allowlisted environment because the parent may still hold `ANTHROPIC_API_KEY`.
    - `claude setup-token` is not used, because it would put a secret back in the app.
  - §11 item 7.
- Master plan:
  - Part I §32: no secrets in logs.
  - Part II §3: environment, narrowed by S0.
  - Part II §24: the preamble, Phase 2 ("never log secrets") and Phase 4 (structured logging).
- `CLAUDE.md`: "No real orders and no secrets in slice 1", "Exits are asymmetric and always allowed", "Never delete or skip a test to go green". On `main`, `CLAUDE.md` already states D9, so this job needs no proposed `CLAUDE.md` text.
- `factory/backlog.md`: S0c. S0d owns dependencies, the lockfile and the compose image digest. S0e owns the DB client and needs S0c first.
- `factory/jobs/001-repo-foundation/`:
  - `round-1/review-security.md` item 2: the value scrub through `hooks.streamWrite`.
  - `round-1/review-risk.md` item 1: a blank Claude key could block an exit.
  - `decision.md` items 6 and 7.
  - `build.md` "For reviewers": the table of leaking shapes, failed boots that are not JSON, `z.url` trimming, and the per-process `nestjs-pino` singleton.
- `factory/jobs/002-database/`:
  - `round-1/review-security.md` note 5: `ERR_INVALID_URL` carries the full URL in `input`.
  - `decision.md` item 4.

## Scope

### In

**Settings (D9)**
- `src/config/settings.ts`: the schema has exactly `DATABASE_URL` and `TRADER_MODE`. An `ANTHROPIC_API_KEY` in the environment is dropped like any unknown variable. It is never required, read or validated.
- Everything else in `settings.ts` stays as on `main`:
  - `TRADER_MODE` is `z.literal('paper')`, with no default.
  - The `DATABASE_URL` rules do not change.
  - `SettingsError` carries key names only.
  - The file stays pure, with no Nest import and no `process` access.
- `.env.example`: remove the `ANTHROPIC_API_KEY=` line. `DATABASE_URL` and `TRADER_MODE=paper` stay exactly as they are.
- `test/fixtures/env.ts`: `fixtureEnv` has the two keys. Keep an Anthropic-key sentinel constant for the tests that prove the variable is dropped and never logged.
- Rewrite the tests that asserted the key is required, so they assert D9 behaviour instead. See "Where the plan and the repo disagree". The affected tests are:
  - in `settings.spec.ts`, the `ANTHROPIC_API_KEY` block and the three-key expectations
  - the `.env.example` block in `repo-files.spec.ts`
  - the env inputs in `app.e2e-spec.ts`
  - the settings shapes in `logging.spec.ts`
- Fix two stale statements:
  - Comment line 5 of `docker-compose.yml`: "the only secret is ANTHROPIC_API_KEY". Change only that comment.
  - In `progress.md`, the "Current state" line that says `ANTHROPIC_API_KEY` is redacted, and the "`.env.example` has three keys" settlement.

**Value-based scrub**
- **Secret values.** A pure function in `src/config/` derives the secret values from the parsed settings. It has no `@nestjs/*` import and no `process` access. Today, if `DATABASE_URL` has a non-empty password, the values are:
  - the URL as loaded, which is the string `parseSettings` returns
  - the password in the percent-encoded form that the WHATWG `URL` parser normalizes it to (`url.password`)
  - the decoded password. If decoding fails, leave out this form and keep the others. Never throw.
  - the JSON-escaped form of each value above, because the hook sees serialized lines

  A URL with no password, or an empty one, yields no secret values. Never scrub the empty string.
- **Scrub.** A pure, exported function replaces every occurrence of every secret value in a line with `[REDACTED]`, longest value first. Export it so later jobs can apply it to text that does not pass through pino.
- **Wiring.**
  - Use pino's `hooks.streamWrite`, placed in the logger options that `src/config/logging.ts` builds from the secret values.
  - Key-path `redact` stays on top, with the same censor, `[REDACTED]`.
  - `AppModule` builds the logger from the `SETTINGS` provider, for example with `LoggerModule.forRootAsync` and `inject: [SETTINGS]`. Settings are parsed once, at boot, never at import, and nothing reads `process.env` a second time.
- **Key paths.**
  - Keep `DATABASE_URL` and `*.DATABASE_URL`.
  - Keep `ANTHROPIC_API_KEY` and `*.ANTHROPIC_API_KEY` as a defensive name. The settings no longer load it, but §9 expects that the parent environment may still hold one, and nothing may log it.
  - Rewrite the comment that says "Do not log these deeper" so it describes the new behaviour.

**Unparseable `DATABASE_URL`**
- Node's `ERR_INVALID_URL` carries the whole input in its `input` property, and Node's printer for uncaught errors shows that property. Any code under `src/` that parses `DATABASE_URL`, including the secret-value function, must not let that error escape. It must either catch the error and throw one with no `input`, no `cause` and no part of the value, or treat the whole value as secret.
- On a parse failure, the secret-value function must never fall back to an empty list.
- `parseSettings` already discards zod's error. Prove that this also holds for unparseable URLs.
- Keep the URL parsing in one place under `src/`, and name that place in `build.md`.

**Repo files**
- `progress.md`:
  - marks S0c done
  - names S0d as next
  - says S0d remains open under S0
  - in "Current state", says settings have two keys and that logs are scrubbed by value as well as by key path
  - in the settlements, says `.env.example` has two keys
- The progress assertions in `repo-files.spec.ts` move forward to match, as S0b did with its own.
- `tests.json` lists every spec file. Update the `covers` text of every changed spec.

### Where the plan and the repo disagree

**`ANTHROPIC_API_KEY`.**
- **The repo.** S0a made it a required non-blank setting. It also appears in:
  - `.env.example`
  - the test fixtures and tests
  - the redact key paths
  - a comment in `docker-compose.yml`
  - `progress.md`
- **The plan.** It was revised on 2026-11-09:
  - §1 says the app holds no secrets.
  - D9 says the app never holds an Anthropic credential.
  - §5 S0 says S0c removes the key.
  - `CLAUDE.md` on `main` agrees.
- **This job follows the plan.** It removes the key everywhere except one place, on purpose: the key-path name in `logging.ts`. That name loads nothing. It only censors the variable if a later bug logs an object shaped like the environment, which §9 says can hold it.

**"No secrets", and the `DATABASE_URL` password.** §1 says the app holds no secrets, and the compose comment calls the local password "not a secret". The backlog still names the `DATABASE_URL` password as the loaded secret value to scrub. The intent is the same: S0 says "Secrets never logged", and master §32 says "no secrets in logs". `DATABASE_URL` can point wherever the user sets it, so its password is treated as a secret in logs and errors, as S0a already treated it.

**Rewritten tests.** The removed assertions were "key required", "blank rejected" and "exactly three keys". They tested behaviour that D9 removes on purpose. Criteria 1 to 5 replace them with assertions of the opposite behaviour, so no test is removed to go green. Criterion 7 checks that every other case in `settings.spec.ts` stays.

**Mechanism.** The backlog names `hooks.streamWrite` only as an example. This spec makes it the default. A scrubbing destination stream is an acceptable fallback, but only if `nestjs-pino` or `pino-http` does not pass the hook through. In that case, explain why in `build.md`.

### Out

- **S0e's database work:** the DB client, a pool, the first connection, the database identity marker, the read-only research role, and the column conventions.
- **Errors printed outside pino.** On a failed boot, two things write to stderr without the scrub: Nest's default logger, before `useLogger`, and Node's printer for the rejected top-level `await`.
  - Criterion 11 proves the one case the backlog names, an unparseable URL.
  - S0e opens the first connection, so its spec should require that a failed connect at boot prints no password through these paths. This job exports the scrub function for that.
- **Failed-boot output as JSON.** S0a `build.md` noted that a failed boot does not log JSON. That stays out of scope.
- **New key-path names** from the S0a security review: `apiKey`, `authorization`, `x-api-key`, `password` and `connectionString`. The value scrub covers the loaded values under any key name, so these paths are not required.
- **Any change to the `DATABASE_URL` values that settings accept.** That rules out a minimum password length or a ban on `%` sequences. The accepted set stays as on `main`, including `z.url`'s trimming.
- **The parent environment's `ANTHROPIC_API_KEY`.** Do not read its value or scrub it. The CLI provider's environment allowlist belongs to S9a.
- **URL parsing in `test/fixtures/db.ts`.** It handles committed fixture values only, which the S0b review found harmless.
- **S0d's work:** dependencies, `package.json` dependency entries, `pnpm-lock.yaml`, the compose image digest, and any change to `docker-compose.yml` other than the one comment.
- **The gate:** tripwires for `@anthropic-ai/sdk` and the gate's protected list. Both belong to the human "Gate paths" item.
- **Protected documents:** any change to `factory/`, `.claude/`, `CLAUDE.md` or the plan documents.

### Stop conditions

- If criterion 20 cannot pass with `hooks.streamWrite` through `nestjs-pino`, or with a scrubbing destination stream, stop and say so in `build.md`. Do not replace `nestjs-pino`, write a custom logger, or add a dependency.
- If removing the key seems to need a change to `factory/`, `.claude/`, `CLAUDE.md` or a plan document, stop and propose the text in `build.md`.

### Gate constraints

- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint` and `pnpm build` must pass under those exact names. No lockfile change is expected.
- The gate does not run `pnpm typecheck` or `pnpm test:e2e`. The unparseable-URL proof and the wiring proof are e2e tests, so the builder runs both commands and pastes their output into `build.md` (criterion 27).
- Tripwires scan the added lines of every non-test, non-`.md` file, including `src/config/`, `.env.example`, `docker-compose.yml` and `tests.json`. Those lines must not contain:
  - `sk-ant-`
  - a Binance key name
  - `withdraw`
  - a quoted forbidden mode near `mode` or `TRADER_MODE`

  Sentinel values belong in test files only.
- `.skip(`, `.only(`, `.todo(`, `xit(` and `fit(` fail the gate, and so does a deleted spec file.
- Expect `NEEDS_HUMAN: yes`, because `src/config/` and `.env.example` are protected paths.

### Builder notes (non-binding)

- **A possible shape:**
  - `secretValues(settings)` and `scrubSecrets(text, values)` in a file such as `src/config/secrets.ts`
  - a `loggerOptions(values)` factory in `logging.ts`
  - `LoggerModule.forRootAsync({ imports: [ConfigModule], inject: [SETTINGS], useFactory })` in `AppModule`

  The check in `drizzle.spec.ts` that `AppModule` imports only `ConfigModule` and `LoggerModule` reads `.module` from dynamic modules, so `forRootAsync` passes it.
- **`pinoOptions` importers.** `logging.spec.ts` and `correlation.spec.ts` import `pinoOptions`. Move them to the new factory.
- **Over-redaction is acceptable. A leak is not.** A degenerate password, such as one or two characters or JSON punctuation, may garble lines. Record what happens in `build.md`. Do not add validation for it.
- **`nestjs-pino` singleton.** Its root logger is a singleton per process (S0a `build.md`). vitest isolates test files, so keep one `LoggerModule` setup per file, or use `pino(options, stream)` directly.
- **Criterion 20's child process.** It can be a small ESM script that imports `dist/app.module.js`, run with `cwd` set to the app folder and an explicit env, like `runMain` in `app.e2e-spec.ts`.

## Acceptance criteria

Each criterion is tagged with how it is proved:
- `unit` runs in `pnpm test`.
- `e2e` runs in `pnpm build && pnpm test:e2e`.
- `shell` is a command whose output the builder pastes into `build.md`.
- `[human]` needs a person.

Several criteria use a sentinel, `<S>`, which is a unique fixture string in the password. The value-scrub criteria use two shorthand terms:
- **"the logger"** is pino built with the options from `src/config/logging.ts`, for settings whose `DATABASE_URL` is `postgresql://trader:<S>@localhost:5432/trader`, writing to a capture stream.
- **"clean"** means all of these hold:
  - every line parses as JSON
  - neither the raw text nor any string in the parsed JSON contains `<S>` or the URL as loaded
  - `[REDACTED]` appears where the secret was

**Settings (D9)**

1. `unit` For valid input, `parseSettings` returns exactly the keys `DATABASE_URL` and `TRADER_MODE`. `expectTypeOf` proves that `keyof Settings` is exactly `'DATABASE_URL' | 'TRADER_MODE'`, and `Object.keys(settingsSchema.shape)` holds those two keys.
2. `unit` `parseSettings` succeeds whether `ANTHROPIC_API_KEY` is unset, empty, whitespace-only or a sentinel. In every case:
   - the result equals the result without the variable
   - `JSON.stringify(result)` does not contain the sentinel

   The "drops every other variable" case includes `ANTHROPIC_API_KEY` as well as `BINANCE_API_KEY`.
3. `unit` `AppModule` boots with only `DATABASE_URL` and `TRADER_MODE` in the environment, and DI returns settings equal to those two values. If `ANTHROPIC_API_KEY` is also stubbed to a sentinel, the settings from DI are the same and do not contain it.
4. `e2e` `node dist/main.js` exits 0 by itself with an env that holds only `DATABASE_URL` and `TRADER_MODE`. It also exits 0 with `ANTHROPIC_API_KEY` set to a sentinel, and the sentinel appears in neither stdout nor stderr.
5. `unit` `.env.example`:
   - has exactly the keys `DATABASE_URL` and `TRADER_MODE`, which equal the settings schema keys
   - sets `TRADER_MODE=paper`
   - passes `parseSettings` as it is, with nothing filled in
   - has the same `DATABASE_URL` value as on `main`, so the compose credential tests still pass
6. `unit` None of these contains `ANTHROPIC_API_KEY`:
   - `docker-compose.yml`
   - `.env.example`
   - the "Current state" section of `progress.md`
   - any non-spec file under `src/` other than `src/config/logging.ts`
7. `shell` A `vitest list` of `settings.spec.ts`, run on `main` and on the branch, shows that the only test names removed are `ANTHROPIC_API_KEY` cases. Every `TRADER_MODE`, `DATABASE_URL`, error-content and purity case is still present.

**Unparseable `DATABASE_URL`**

8. `unit` The test uses at least three `DATABASE_URL` values that make `new URL` throw, each with `<S>` as the password, and first asserts that each one throws. Suggested values:
   - a port out of range: `postgresql://trader:<S>@localhost:99999/trader`
   - an unclosed IPv6 bracket: `postgresql://trader:<S>@[::1/trader`
   - a space in the host: `postgresql://trader:<S>@bad host/trader`

   For each value, `parseSettings` throws a `SettingsError` that meets all of these:
   - `invalidKeys` equals `['DATABASE_URL']`
   - `cause` is undefined
   - `<S>` is absent from the `message`, the `stack`, `JSON.stringify(error)` and `util.inspect(error, { showHidden: true, depth: null })`
9. `unit` Each function under `src/` that parses `DATABASE_URL` is called directly with the same values. That includes at least the secret-value function, and `build.md` names them all. Each call must do one of two things:
   - Throw an error that meets all of these:
     - it has no `input` property
     - its `cause` is undefined
     - `<S>` is absent from its `message`, `stack` and `util.inspect(error, { showHidden: true, depth: null })`
   - Return without throwing. The secret-value function must then return a non-empty list that covers the whole value.
10. `unit` Two source checks on non-spec files under `src/`:
    - `new URL(` appears only in the files that criterion 9 names.
    - `process.env` appears only in `src/config/config.module.ts`.
11. `e2e` `node dist/main.js` is run with each value from criterion 8 as `DATABASE_URL`. Each run:
    - exits non-zero, and not by a signal (the exit code is not `null`)
    - names `DATABASE_URL` in stderr
    - writes `<S>` to neither stdout nor stderr

**Value-based scrub**

12. `unit` Nested more than one level deep: `{ a: { b: settings } }`, `{ a: { b: { c: settings } } }` and `{ list: [settings] }`, logged through the logger, are clean.
13. `unit` Under key names that are not in the key-path list: `{ apiKey: <password> }`, `{ password: <password> }`, `{ connectionString: <url> }` and `{ dsn: <url> }` are clean.
14. `unit` Interpolated into the message: a template string that contains the URL, a template string that contains the password, and printf-style `logger.info('connect %s', url)` are all clean. The rest of the message survives, so `msg` still starts with the literal prefix.
15. `unit` Errors and bindings are clean:
    - an `Error` whose message contains the URL, logged as `logger.error({ err })`, in both `err.message` and `err.stack`
    - an `Error` whose `cause` is an `Error` that contains the password
    - `logger.child({ conn: url }).info('x')`
16. `unit` Encoded passwords. Each case logs the forms listed, both in a message and under an unlisted key, and the output is clean in its raw text and in its parsed values:
    - `postgresql://trader:pw%22q%5Cs%40-<S>@localhost:5432/trader`, which decodes to `pw"q\s@-<S>`. Logged forms: the URL as loaded, the normalized password and the decoded password. In JSON, the decoded form serializes with escaped characters.
    - `postgresql://trader:mix@d%20<S>@localhost:5432/trader`, a password written with mixed encoding. Logged form: the URL as loaded.
    - `postgresql://trader:pa%zz-<S>@localhost:5432/trader`, whose password does not decode. Logged forms: the URL as loaded and the normalized password. Building the logger options does not throw.
17. `unit` No secret means no change. For `postgresql://localhost/trader`, `postgresql://trader@localhost/trader` and `postgresql://trader:@localhost/trader`:
    - the secret-value function returns no values
    - a line whose message holds that URL is written with `msg` unchanged and no `[REDACTED]`

    With a password set, a line that holds no secret form also keeps `msg` unchanged and has no `[REDACTED]`.
18. `unit` Key paths still apply:
    - `{ DATABASE_URL }`, `{ settings }`, the settings object itself, `{ config: settings }` and child bindings `{ settings }` show `[REDACTED]` at the same paths as on `main`.
    - `TRADER_MODE` stays `paper`.
    - `{ ANTHROPIC_API_KEY: <sentinel> }` is still redacted by key path.
19. `unit` A `nestjs-pino` `Logger` built on the same options scrubs one shape from each of criteria 12 to 15. That includes `logger.log(message, context)` with the URL in the message.
20. `e2e` A child process boots the built `AppModule` from `dist/`, with a fixture env whose password is `<S>`. It logs one shape from each of criteria 12 to 15 through the context's `Logger`, closes the context and exits 0. Every stdout line is clean.
    - Stdout also contains Nest's boot lines, with context `InstanceLoader`. This shows that the buffered boot logs still pass through the scrubbing logger.
    - A unit test that boots `AppModule` itself is an acceptable alternative, if it needs no test-only switch in production code.
21. `unit` The secret-value and scrub functions live in files under `src/config/` that import nothing from `@nestjs/` and contain no `process.`. Importing `src/app.module.ts` with an empty environment still does not throw.
22. `shell` Mutation check, reverted afterwards with the worktree confirmed clean, and the output pasted into `build.md`:
    - With the scrub removed from the logger options (hook deleted, key paths kept), criteria 12 to 16 and 20 fail.
    - With `AppModule` switched back to static options that lack the scrub, criterion 20 fails.

**Existing behaviour holds**

23. `e2e` The existing e2e suite passes, with its env inputs updated for D9. That covers:
    - a valid env exits 0 by itself
    - JSON lines with a UTC time
    - Nest's boot lines go through pino
    - one startup line with `mode: paper` and a UUID `correlationId`
    - no fixture password in the output
    - no database connection at boot
    - refusal of a non-paper or unset `TRADER_MODE` without leaking
24. `unit` The log-line shape tests (level, `msg`, ISO-8601 UTC time) and the correlation tests still assert the same behaviour.

**Repo files**

25. `unit` `progress.md`:
    - marks S0a, S0b and S0c done
    - names S0d as next
    - says S0d remains open under S0
    - mentions the value-based scrub in its "Current state" section
26. `unit` `tests.json` lists every spec file exactly once. This is the existing test.

**Job boundaries**

27. `shell` `pnpm typecheck` and `pnpm build && pnpm test:e2e` each exit 0, and their output is in `build.md`.
28. `shell` The diff stays inside the job:
    - `git diff --name-only main...HEAD` lists nothing under `factory/`, `.claude/`, `src/db/` or `research/`. It lists neither `CLAUDE.md` nor a plan document.
    - The `dependencies` and `devDependencies` in `package.json`, and `pnpm-lock.yaml`, are unchanged.
    - `git diff --name-status --diff-filter=D main...HEAD` lists no spec file.
29. `shell` `factory/gate.sh 003-settings-redaction` reports `GATE: PASS` and `NEEDS_HUMAN: yes`. The orchestrator runs this.
30. `[human]` A human:
    - reads the protected changes: everything changed under `src/config/`, and `.env.example`
    - confirms that `ANTHROPIC_API_KEY` stays as a defensive key path only
    - confirms that scrubbing errors printed outside pino is left to S0e
    - optionally removes `ANTHROPIC_API_KEY` from their own `.env`. The app now ignores it.

## Rules that apply

- **No real orders and no secrets in slice 1 (D9, `CLAUDE.md`).**
  - After this job, the app loads no Anthropic credential and no Binance key.
  - `TRADER_MODE` still accepts only `paper`, with no default.
  - `settings.ts` still does not contain the word for the other mode.
- **Secrets are never logged** (§5 S0, master §32, Part II §24 Phase 2). This covers error messages, stacks and inspected error properties, as well as log lines.
- **Exits are always allowed, and a Claude outage never blocks one** (D11, D14). Boot no longer needs any Claude configuration, which settles S0a risk review item 1 and decision item 7 as far as settings go. S10 and S11 still own the tests for booting the exit and `kill --flatten` paths.
- **D11: crash loudly.**
  - Invalid settings and an unparseable URL still refuse boot with a non-zero exit.
  - The scrub never swallows an error.
  - The secret-value function never falls back to "no secrets" while a password exists.
- **Invalid data is never silently used.** The settings that are accepted and rejected do not change, apart from dropping the Anthropic key.
- **Never delete or skip a test to go green.** Only assertions of the removed D9 behaviour change. They are replaced by assertions of the new behaviour, and criterion 7 checks that every other case stays.
- **Factory agents never read `.env`.** Tests use fixture values and sentinels, passed explicitly.
- **Pure functions.** The settings, secret-value and scrub code has no Nest or `process` dependency, as `settings.ts` already has none.
- **UTC everywhere.** Log timestamps stay ISO-8601 UTC.
- **ESM.** Relative imports end in `.js`.

This job does not touch the entry gate, the 48-entry limit, exits, EV, `Decimal` or the look-ahead rule, because it has no trading logic.

## Open decisions

- **§11 item 7, subscription terms.** This job carries out D9's "no API key". It uses the plan's default: D9 stands as written, so Claude runs under the user's own login. If item 7 goes the other way and D9 is revisited, an API credential would come back in its own job. It would arrive as a settings key, and the secret-value function would cover it.
- No other §11 item affects this job.

These spec-level choices are not §11 items. Criterion 30 puts them in front of a human, and the protected-path gate result sends this job to needs-human in any case:
- `ANTHROPIC_API_KEY` stays as a defensive redact key path, with no setting behind it.
- The URL as loaded is scrubbed as a whole, together with each form of the password.
- Scrubbing errors printed outside pino at boot is left to S0e.
