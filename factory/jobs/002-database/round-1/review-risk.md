VERDICT: PASS

## Scope

Mostly out of scope for a trading-safety review. S0b adds Postgres in Docker, Drizzle with a comment-only first migration, `make db-up`, a DB test suite and the `research/` skeleton. Under `src/` it changes only `src/db/schema.ts` (no tables) and `src/db/migrations/`. It has no order path, risk engine, entry gate, 48-entry counter, exit path, kill switch, money value or order state. The app still opens no database connection: `drizzle.spec.ts` checks the source text and the `AppModule` metadata, and the e2e case "boots and exits 0 without connecting" counts 0 connections.

Checked and clean:
- `TRADER_MODE=paper` is unchanged in `.env.example`, and the existing tests that refuse `live`, `testnet` and `PAPER` still pass. No Binance key name, exchange package or `withdraw` appears in the diff or in the lockfile.
- Schema changes can only go through committed migrations under the protected `/src/db/migrations/`. No script uses `drizzle-kit push`, and `drizzle.spec.ts` tests for that. A human will therefore review every future change to the risk-event, counter and kill-switch tables.
- Failures are loud. `make db-up` runs under `set -eo pipefail` with nothing masked. A wrong password, a refused connection or an unset URL makes `db:migrate` exit non-zero, and the password is not printed (tested in `migrate.db-spec.ts`).
- The DB test guard (`test/fixtures/db.ts:10`, `^trader_test_[a-z0-9_]{1,40}$`) allows only throwaway databases. It also refuses any URL with a query string. Every create, migrate and drop call goes through it, so a test run cannot drop or migrate the `trader` ledger. `guard.spec.ts` tests this, including an injection attempt.
- Postgres runs in UTC, and `server.db-spec.ts` checks that. `pg` keeps returning `numeric` as a string, because nothing here changes the type parsers.

## Findings

No blocking findings.

Non-blocking advisories for later jobs. None is a defect in this job.

1. **The gate never runs DB-backed safety tests.** `factory/gate.sh:51` runs only `pnpm test`, and by design `vitest.config.db.ts:11` keeps `*.db-spec.ts` out of it.
   - Scenario: S7b adds the 48-entry rolling counter. Its core proofs need a real Postgres:
     - the count happens inside the approval transaction
     - two concurrent approvals at entry 47 cannot both pass
     - the window boundary holds
     - a restart keeps the count
   - Those tests would then be `*.db-spec.ts` files, so a regression that lets a 49th entry through could still get `GATE: PASS`.
   - Fix (backlog or orchestrator, because `factory/` is off limits here): before S7b, either make the gate run `pnpm test:db` against a throwaway compose project, or require S7b's spec to cover the counter's hard-rule tests in a suite the gate runs.

2. **Ledger identity is not checked.** The compose project and volume names come from the checkout folder: there is no `name:` in `docker-compose.yml:10`. Every checkout publishes on the same `127.0.0.1:55432` (`.env.example:2`, `Makefile:9`).
   - Scenario A: a factory worktree's compose project is still running, and the main app starts with the `.env.example` URL. The app silently uses the worktree's scratch ledger. Its 48-entry counter reads 0, and a kill switch latched in the real ledger is not seen, so entries are approved that the real ledger would block.
   - Scenario B: the repo folder is renamed. `make db-up` creates a new empty volume and migrates it without complaint, with the same effect.
   - Fix, in the job that adds `src/db/client.ts` (after S0c): store a one-time ledger identity in the database, compare it at boot with a configured value, and treat a mismatch or a missing identity as UNKNOWN. That must block entries and never be read as "zero entries so far". Exits must stay allowed.

3. **Money column types.** When tables arrive, prices, quantities, fees and P&L must be `numeric` in its default string mode. Never `numeric({ mode: 'number' })`, `real`, `doublePrecision`, or `bigint({ mode: 'number' })`, because those return JS `number`. A unit test that scans `src/db/schema.ts` for these forms would enforce the Decimal rule at the schema layer.

4. **Research credentials.** D13 ("never writes trading tables") is currently enforced only by `research/README.md`. The only database role is `trader`, a superuser. The read-only role is already planned for the first research task. It must exist before any research code connects, otherwise research could write to the counter or kill-switch tables.
