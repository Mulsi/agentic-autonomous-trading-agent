VERDICT: PASS

## Findings

This job doesn't touch these: order paths, the risk engine, the entry gate, the 48-entry counter, the kill switch, exit logic or Claude. What it adds that matters for risk is the database identity status, which S7a and S7b will consume. I checked that status for fail-open paths and found none:

- `decideIdentity` (src/db/identity.ts:39-63) returns `VERIFIED` only on an exact match with a single stored row.
- `blocksEntries` (src/db/identity.ts:66-68) is `!== 'VERIFIED'`, so a corrupt status also blocks.
- Every error path in `markerReadFailure` and `readMarker` lands on `UNKNOWN`.
- An `UNKNOWN` boot exits 0, so nothing gates exits on it (e2e criterion 10).
- Refused settings never connect (`db.module.ts:25-29` null guard, plus criterion 14).
- Connect has no retry and a 5 s bound (e2e 13b and 13c).
- No type parser changes, and money stays string `numeric`.
- `research_reader` cannot write.

The mutation evidence (M3, M4, M6, M7) shows the tests bite. Nothing below blocks. Items 1 to 3 are cheap enough to do in this round if a round 2 happens anyway.

1. **The setup steps would re-pin a stand-in ledger** (progress.md:38-42; also build.md "For the human" step 4).
   - Scenario: the main folder is renamed. The old container is stopped, `make db-up` makes a new volume and a new marker, and the app logs `warn UNKNOWN mismatch marker=<new>`.
   - Every documented step then passes in the renamed folder. In particular, step 3's `docker compose ps` shows the checkout's own container answering.
   - So following the steps sets `DATABASE_IDENTITY` to the empty database. It reads `VERIFIED`, with the 48-entry counter at 0 and no kill switch. That is exactly the case this job exists to catch, and the code catches it. Only the human procedure undoes it.
   - Fix: add one sentence to the setup and to the S7a/S7b hand-off. The setup is for the first run of a database only. A later `mismatch` or `missing_marker` on a checkout that was `VERIFIED` before is an incident (Rule 9: reconcile, verify, resume). Find the original volume before changing `DATABASE_IDENTITY`, and never copy the marker from a `mismatch` line to clear it.

2. **A dropped connection during the marker read crashes the boot instead of giving `unreadable`. It is untested** (src/db/client.ts:108-116).
   - While the client is checked out, it has no `error` listener: pg-pool 3.14 `_acquireClient` removes the idle listener.
   - Scenario: the server authenticates, then the socket resets mid-SELECT (container killed, docker-proxy closes). pg 8.23.1 `Client._handleErrorEvent` (lib/client.js:416-423) emits `error` synchronously, with no listener.
   - The result is an uncaught exception. The process exits 1 through Node's printer, unscrubbed, though that message holds no secret.
   - This fails closed and loud, so it is not a risk blocker. But it contradicts the spec ("`unreadable`: any other failure after the connection opened ... never fails the boot").
   - Fix: attach a temporary `client.on('error', ...)` for the duration of `readMarker`, removed before `release`. Test it with a fake server that sends AuthenticationOk and ReadyForQuery, then destroys the socket on the first Query. Assert `{ kind: 'failed' }`, `UNKNOWN unreadable` and exit 0. If you prefer the crash, record it in progress.md as "a connection lost during the read fails the boot".

3. **The marker read timeout has no test** (src/db/client.ts:16, 102-106; test/unit/db/client.spec.ts:204 only asserts `> 0`).
   - `query_timeout` is typed through a hand-written intersection, so a misspelled key would still compile.
   - Scenario: the SELECT blocks. For example, an operator's `LOCK TABLE database_identity`, or a later migration that holds ACCESS EXCLUSIVE.
   - Without a working timeout the boot hangs forever. `launchd` never restarts a hung process, and once exits live in this process, none run.
   - I confirmed that pg 8.23.1 honours `config.query_timeout` (lib/client.js:702), so the code is right today.
   - Fix: use the same fake server as item 2, answering nothing after the Query. Assert `failed` within `MARKER_READ_TIMEOUT_MS` plus a margin. Alternatively, write a db-spec that holds ACCESS EXCLUSIVE on `database_identity` from a second connection.

4. **Handing the identity re-check to S11a and S12 leaves a window** (progress.md:112-113).
   - `IDENTITY` is a snapshot taken at boot. The pool opens new physical connections lazily, to whatever answers `127.0.0.1:55432` at that moment.
   - Scenario: the main container is stopped and a worktree's container comes up mid-run. Boot-time `VERIFIED` stays, and the counter reads 0. A periodic re-check still leaves a window.
   - Fix: add to the S7b hand-off that the risk-approval transaction reads `database_identity.marker` in the same snapshot as the counter and the kill switch, and rejects on any difference from the configured value.

5. **The `unreadable` reason drops its cause** (src/db/client.ts:111-114).
   - The caught error is discarded, so the warn line says `unreadable` with no SQLSTATE or error class. That leaves the operator nothing to reconcile from.
   - Fix: carry `code` or the error name in the `failed` read and log it on the identity line. pino already scrubs.

6. **The schema scan is a deny-list** (test/fixtures/schema-scan.ts:18-43, `default: return undefined`).
   - `integer`, `smallint`, `serial`, `bigserial({ mode: 'number' })` and `json`/`jsonb` all pass. A `jsonb` fill or snapshot holding prices comes back as JS `number` through `JSON.parse`.
   - The spec scoped the banned forms, and build.md "For reviewers" item 7 flags part of this.
   - Fix, in the first job that adds money columns (S7b or S8): turn the scan into an allow-list of column types, and require money inside `jsonb` to be strings.

7. **The "never writes the marker" source check is narrow** (test/unit/db/drizzle.spec.ts:364-392).
   - The word match is case-sensitive, as the spec asks. So ``db.execute(sql`insert into database_identity ...`)`` in lower case passes `pnpm test`. Only e2e criterion 11 catches it, and the gate does not run e2e.
   - S7b will also have to narrow the `.insert(` ban once it writes the counter.
   - Fix, when it is narrowed: keep a marker-specific check. No non-migration source should name `databaseIdentity` or `database_identity` (in any case) outside a select.

8. **Low priority: `research_reader` sessions have no time limit** (src/db/migrations/0003_research_reader.sql).
   - An idle-in-transaction notebook holds ACCESS SHARE indefinitely. A later migration's ACCESS EXCLUSIVE then waits, and every app statement on that table queues behind it.
   - Fix, in a later migration: set `idle_in_transaction_session_timeout` and `statement_timeout` on the role.
