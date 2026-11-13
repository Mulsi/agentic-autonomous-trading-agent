VERDICT: PASS

## Findings

No blocking items. In the worktree at 6e22bf7, `pnpm test` (577 tests), `pnpm lint` and `pnpm typecheck` pass. The DB and e2e specs were read but not run. The round-2 diff touches only files the five items need.

Checks per item:

1. Setup limited to a first run: `progress.md` now says the setup applies only to a database's first run. It says a later `mismatch` or `missing_marker` is an incident. It also says the marker on a `mismatch` line is never copied into `.env`. progress.md is the only place the setup steps live (`.env.example` just has the empty key). A repo-files test pins the wording.
2. Reset during the marker read: `src/db/client.ts` `readMarker` adds an `error` listener for the duration of the query. It releases first, with a destroy flag on failure, and removes the listener afterwards. A fake server (`test/fixtures/fake-postgres.ts`) resets the socket mid-read, and `test/unit/db/marker-read.spec.ts` covers it. The build log shows the unit test failing with an unhandled `ECONNRESET` when the listener line is removed. An e2e spec checks that the boot carries on and logs `unreadable`.
3. Read timeout: unit test (silent fake server), e2e test and DB test (lock on `database_identity`). All three assert `unreadable` within the bound.
4. Query string or fragment: `settings.ts` adds `.refine(!/[?#]/)` on `DATABASE_URL`. The issue carries only the key, and tests check it leaks no value. The S0d generator now files these URLs as near misses, and the acceptance threshold is unchanged. Percent-encoded `?` and `#` in the password are still accepted.
5. `verifyDepsBeforeRun: error` is in `pnpm-workspace.yaml`. A test pins the value, and the allowed-keys test is updated. The build log shows an offline `pnpm test` with an edited manifest failing before vitest runs. It also shows a control run where an invalid value is rejected, and frozen install followed by test still passing.

Non-blocking notes:

- `test/unit/db/marker-read.spec.ts`: the timing assertion `elapsed >= MARKER_READ_TIMEOUT_MS - 50` depends on pg's timer resolution. It has a 2s upper margin and is probably fine. If it ever flakes, loosen the lower bound.
- `src/db/client.ts` `readMarker`: after `client.release(true)`, pg may still emit a late `error` on the destroyed client once our listener is off. The tests show a clean close, so no action is needed. Watch for it if it ever shows up.
- One test name was removed ("holds only allowBuilds and overrides"). The rename is justified by the new key and disclosed in build.md.
