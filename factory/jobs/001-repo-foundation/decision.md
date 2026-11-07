ESCALATE

## Why

Two approval rules fail. The spec expected both (`spec.md:117`, `spec.md:199`), so neither is a defect in the build.

- **`gate.md` says `GATE: PASS` but `NEEDS_HUMAN: yes`.** The job changes protected paths: `.env.example` and three files under `src/config/`.
- **The spec has a `[human]` criterion.** Criterion 37 needs a person to confirm the D1 and linter settlements and apply the `CLAUDE.md` text. Nobody has done that yet.

Apart from those two rules, I found nothing that should stop this merge:

- **Commit:** branch at `6102c80`, one commit on top of `main`. `main` has not moved and the worktree is clean.
- **Scope:** the diff touches nothing under `factory/` or `.claude/`, nor `CLAUDE.md` or the plans. No spec file was deleted. The only deletions are `.oxlintrc.json`, `app.controller.ts` and `app.service.ts`, as the spec asks.
- **Trading:** there is no trading logic. A search of the added non-test lines found no risk, order, position, price or fee terms. `TRADER_MODE` is `z.literal('paper')` with no default.
- **Tests:** rewritten scaffold tests assert the replacement behaviour. I found no hidden skips such as `skipIf`, and no `@ts-ignore` or `eslint-disable`. Tests pass explicit fixture env and never read a real `.env`.
- **Reviews:** all four passed. Their non-blocking notes do not block this merge, but several are real risks for later jobs, and only the review files record them.

I read the code and ran nothing, so test results come from `gate.md` and `build.md`.

## What a human should check

**Before merging**

1. **Confirm the D1 settlement** (`spec.md:72-78`). The app stays in `local-trading-agent-backend/`, and `prompts/` and `scripts/` must stay in that folder so the protected patterns keep matching.
2. **Confirm the linter settlement** (`spec.md:80`). typescript-eslint replaces oxlint. The builder chose `recommendedTypeChecked` rather than `strictTypeChecked`.
3. **Read the protected files:** `.env.example`, plus `settings.ts`, `config.module.ts` and `logging.ts` in `local-trading-agent-backend/src/config/`.
4. **Run `pnpm build && pnpm test:e2e` yourself.** These tests are the only process-level proof for criteria 15, 27, 29 and 30: exit by itself, refusal of non-paper modes, JSON logs and no secrets in output. The gate does not run them and no reviewer did. `build.md` says they pass but pastes no output, although `spec.md:114` asks for it.

**At merge**

5. **Apply the `CLAUDE.md` text** from "Proposed CLAUDE.md text" in `build.md`. Until then, the lint comment and the "Known gaps" section are stale.

**Decide before later jobs**

None of these four is recorded in `factory/backlog.md` or `progress.md`, so each needs a home or it will be lost.

6. **Secret redaction matches key paths only** (`src/config/logging.ts:6-11`). The builder reports that a secret leaks in clear if it is nested two levels deep, stored under another key name, or interpolated into a message. Nothing logs those shapes today. Fix this before the first job that opens a database connection or calls Claude, because driver and SDK errors are the likely leak. `progress.md:10` says the two secrets "are redacted" without this limit.
7. **A blank `ANTHROPIC_API_KEY` refuses boot.** This is correct now, because criterion 21 requires it and no exits exist. But if `trader kill --flatten` or the exit paths boot through the same `AppModule`, a Claude config problem would block an exit, which `CLAUDE.md` forbids. Add this as a requirement for S10 and S11, with a test.
8. **The gate's protected list has gaps** (`factory/gate.sh:12`). It does not cover the planned entry gate, exit or EV code (`src/signals/`, `src/positions/`, `src/stats/`), so those jobs would not force `NEEDS_HUMAN`. Decide before S4 whether to extend it. Only a human can change `factory/`.
9. **Express is still installed.** `@nestjs/platform-express`, `express` and `multer` remain in the lockfile as an optional peer of `@nestjs/core`, and I confirmed they are in `node_modules`. The security review reports one high advisory on `multer`, and no app code reaches it. Criterion 16 is met as written, but a future `NestFactory.create` would get a working HTTP adapter instead of failing. The security review proposes a separate lockfile refresh, which moves Nest from 12.2.0 to 12.4.0 and is untested. The `tests.json` entry for `no-telemetry.spec.ts` overstates this: it says HTTP packages are removed from the lockfile, but the test checks only `@nestjs/observe` there.

**Minor correction**

10. **`build.md:277` is wrong about `pnpm start`.** The installed `@nestjs/cli` source skips a missing `../.env` with a notice and starts anyway. Only `start:prod` stops on a missing file. It still fails closed, because `parseSettings` has no defaults. S11's `launchd` work should not rely on the note as written.
