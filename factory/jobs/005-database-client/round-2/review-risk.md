VERDICT: PASS

## Findings

This job still touches none of these: order paths, the risk engine, the entry gate, the 48-entry counter, the kill switch, exits or Claude. Round 2 (`6e22bf7`) closes the three risk items the human sent back, and it opens no fail-open path. I checked each one against pg 8.23.1 and pg-pool 3.14.0 as installed, and re-ran `marker-read.spec.ts`, `settings.spec.ts` and `identity.spec.ts` with `vitest` directly. All 114 tests passed.

**Item 1, the setup steps (progress.md:38-43, build.md "For the human" step 4): fixed.**
- Both places now say the setup applies only to a database's first run, and that it never clears an `UNKNOWN`.
- A later `mismatch` or `missing_marker` is called an incident under Rule 9.
- The text forbids both ways of pinning a stand-in: copying a `mismatch` marker, and migrating a `missing_marker` database and copying its new marker.
- `repo-files.spec.ts` pins the wording.

**Item 2, a dropped connection mid-read (src/db/client.ts:111-125): fixed, and it fails closed.**
- The listener goes on synchronously after `pool.connect()` resolves, so no socket event can arrive before it.
- On a reset, pg's `_handleErrorEvent` calls `_errorAllQueries` before it emits. So the query always rejects, and the read becomes `failed`, which decides to UNKNOWN `unreadable`. The swallowed event is not a swallowed failure.
- `release(true)` runs before `off`. pg-pool's `_release` re-attaches its idle listener first (index.js:385), so the client is never left without one. `_remove` then calls `client.end()`, which sets `_ending`. pg suppresses a later ECONNRESET or EPIPE (connection.js:56) and the "terminated" error (client.js:210) on an ending client, so no late event can reach the pool unheard.
- A server FATAL during the query also works. The ErrorMessage rejects the query, and the microtask that releases the client runs before the socket's `end` macrotask.
- The mutation in build.md shows that the unit test fails on an uncaught ECONNRESET without the listener. The e2e test shows exit 0 with one `warn` line saying `unreadable`.

**Item 3, the read timeout: proven three ways.**
- A fake server that never answers, in both the unit and e2e suites.
- A real `LOCK TABLE ... ACCESS EXCLUSIVE` in the DB suite, which also confirms that no app session is left behind.
- Each asserts `failed` or `unreadable` between 5 s and 7 s (under 10 s in e2e). A misspelled `query_timeout` key would now fail these tests.

**Item 4, a query string or fragment in `DATABASE_URL` (src/config/settings.ts:10-12): fixed.**
- The refusal only ever rejects more. A raw `?` or `#` can never be part of a valid password, so nothing legitimate is lost.
- Encoded `%3F` and `%23` are still accepted.
- The client still ignores a query string as a second guard.

**Item 5, `verifyDepsBeforeRun: error`:** not a trading-safety item. I have no risk objection.

### Not blocking, carried forward

1. **A pool with no `error` listener crashes the process, which matters once exits live here (src/db/client.ts:78).**
   - `connectDatabase` never calls `pool.on('error', ...)`. If an idle pooled client loses its socket, pg-pool's `idleListener` calls `pool.emit('error')` (pg-pool index.js:52-62), and with no listener Node throws that as an uncaught exception.
   - Today this is harmless. The boot closes the context at once, and the released client leaves within the 10 s default idle timeout.
   - In S7 and later, the process stays up and the pool is used continuously. A Postgres restart would then kill the process, and every in-process exit with it, until a supervisor restarts it.
   - progress.md:13 and :114 record this only as unscrubbed output.
   - Fix, in the job that first keeps the process running (S7b or S11a): attach a pool `error` handler that logs the error scrubbed and sets the identity or DB health to UNKNOWN, so entries block and exits keep running. Test it with the `reset-on-query` fake server, adapted to reset an idle connection.
2. **Round-1 risk items 4 to 8 remain hand-offs, as the human asked.**
   - Item 4 matters most. S7b's risk-approval transaction should re-read `database_identity.marker` in the same snapshot as the 48-entry counter and the kill switch, and reject on any difference.
   - progress.md:113-114 gives S7b the "never read an unverified database as zero" rule and gives S11a and S12 the re-check. Make sure the S7b spec states the same-transaction read explicitly.
