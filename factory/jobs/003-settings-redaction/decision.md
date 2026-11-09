ESCALATE

## Why

The work looks sound. Escalation is required anyway, for four separate reasons:

1. **`gate.md` says `NEEDS_HUMAN: yes`** (`GATE: PASS` otherwise). The protected paths changed are `.env.example`, `src/config/logging.ts`, `src/config/secrets.ts` (new) and `src/config/settings.ts`.
2. **The spec has a `[human]` criterion.** Criterion 30 needs a person to read the protected changes and confirm two scope choices.
3. **The spec has Open decisions.** §11 item 7 (D9 stands, so Claude runs under the user's login), plus three spec-level choices it routes to a human: `ANTHROPIC_API_KEY` stays as a defensive key path, the whole URL is scrubbed along with each form of the password, and scrubbing errors printed outside pino is left to S0e.
4. **The change alters secret handling:** what the app loads as configuration and how it redacts credentials from logs and errors. A person should sign off on that.

What I verified, so the human can trust the evidence:
- **The diff stays in scope.** It touches 18 files. Nothing is under `factory/`, `.claude/`, `src/db/` or `research/`, and neither `CLAUDE.md` nor a plan document changes. No spec file is deleted. `package.json` and `pnpm-lock.yaml` are unchanged. The worktree is clean, and no added line matches a tripwire pattern or `.skip`/`.only`/`.todo`/`xit`/`fit`.
- **The production code is small and matches the spec.**
  - `settings.ts` drops one schema line.
  - `secrets.ts` is pure. It has no Nest import, no `process`, and the only `new URL(` under `src/`. It never returns `[]` for an unparseable value; it throws `SettingsError(['DATABASE_URL'])` outside the `catch`, so the error has no `input` and no `cause`.
  - `logging.ts` becomes a `loggerOptions(secrets)` factory with `hooks.streamWrite`. The key-path `redact` and its `[REDACTED]` censor are unchanged.
  - `AppModule` uses `LoggerModule.forRootAsync({ inject: [SETTINGS] })`.
- **No test was removed to go green.** The only test names removed are the D9 `ANTHROPIC_API_KEY` cases and "returns exactly the three keys", each replaced by an assertion of the opposite behaviour. The `repo-files.spec.ts` progress assertions moved forward, as the spec requires. The key-path redaction tests now run with `loggerOptions([])`, which isolates the key-path layer, so they are stricter than before.
- **Evidence is in `build.md`.** It covers the criterion 7 `vitest list` comparison, both criterion 22 mutations (each one makes tests fail, and the worktree was confirmed clean afterwards), and the criterion 27 `typecheck`/`build`/`test:e2e` output.
- **All four reviews (code, quant, risk, security) say PASS.** Their non-blocking notes are real but correctly marked non-blocking, and I list them below so they are not lost. No review dismissed a concern I think should block.

## What a human should check

1. **Criterion 30: read the protected changes.** Read `local-trading-agent-backend/src/config/settings.ts`, `src/config/secrets.ts`, `src/config/logging.ts`, `src/app.module.ts` and `.env.example` in `git diff main...factory/003-settings-redaction`.
   - Confirm that `ANTHROPIC_API_KEY` stays only as a defensive redact key path in `logging.ts` and loads nothing.
   - Confirm that scrubbing errors printed outside pino on a failed boot is left to S0e. Those errors come from Nest's `ConsoleLogger` before `useLogger`, and from Node's printer for the rejected top-level `await`.
2. **Open decision §11 item 7.** Confirm D9 stands as written: no Anthropic API key, and Claude runs under your own CLI login.
3. **Re-run the e2e locally if you want first-hand proof.** The gate does not run `pnpm test:e2e` or `pnpm typecheck`; their results in `build.md` were pasted by the builder. `app-logger.spec.ts` covers the wiring under `pnpm test`, but criteria 4, 11 and 20 are e2e-only. Command: `. factory/env.sh && cd local-trading-agent-backend && pnpm build && pnpm test:e2e`.
4. **Known gaps in scrub coverage that you are accepting.** All are recorded in `build.md` and the security review.
   - In a mixed-encoding URL such as `mix@d%20<S>`, the password as written, logged on its own, is not scrubbed.
   - A password containing `"`, `\` or a control character is not scrubbed if something JSON-encodes it twice before logging.
   - A degenerate password over-redacts. One character, `paper`, or `info` garbles lines. A password that decodes to `"`, `:` or `{` makes lines stop being JSON. There is no leak in any of these cases, but log-derived analysis would break.

   Decide whether S0e's spec should require two things the security review suggests: a test that the password the DB client derives is one of the `secretValues` forms, and adding the as-written userinfo slice as a scrubbed form.
5. **Carry these into later specs.**
   - **S0e.** The first DB connection adds driver errors to the unscrubbed failed-boot stderr paths, so S0e must apply `scrubSecrets` there.
   - **S0d.** The claim that "`secretValues` cannot throw at boot" rests on zod 4.6.7 `$ZodURL` internals. A failure there would refuse boot, and position management would stop with it. The risk review suggests a fast-check property for S0d: any `DATABASE_URL` that `parseSettings` accepts must not make `secretValues` throw.
   - **Any later job that boots a second application context in one process,** such as a CLI kill/flatten path. The `nestjs-pino` root logger is a per-process singleton, so that context would reuse the first boot's secret values.
   - **S10/S11** still owe the test that exit and `kill --flatten` paths boot with no Claude configuration.
6. **Optional:** remove `ANTHROPIC_API_KEY` from your own `.env`. The app now ignores it.
7. **Merge order:** S0e depends on this job, so merge it before S0e opens a database connection.
