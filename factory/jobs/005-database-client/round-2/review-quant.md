VERDICT: PASS

## Findings

No blocking findings.

Round 2 (commit `6e22bf7`) is the five items from `human-note.md`, and none of them adds data or math. It adds no market data, indicators, splits, fills or EV. The files that carry the quant conventions are unchanged since round 1: `src/db/schema.ts`, `src/db/identity.ts`, `test/db/round-trip.db-spec.ts` and `test/fixtures/schema-scan.ts`. So round 1's checks still hold: numeric stays a string, the session runs in UTC, the DST instants are right, the zone-control arithmetic is right, the `_ms` bigint is exact, and the identity decision is deterministic. I re-checked only what round 2 touches.

### What I verified in round 2

- **No type parser changes** (`src/db/client.ts`). The new `readMarker` code adds only an `error` listener and moves the release into `finally`. It has no `setTypeParser` call, and it does not change pool options, the `-c TimeZone=UTC` session setting or the query. `numeric` and `int8` still come back as strings, as before.
- **`readMarker` result**:
  - `VERIFIED` can only come from `{ kind: 'rows', markers }` after a successful query. Every rejection, whether a reset, `query_timeout` or anything else, goes through `markerReadFailure`, which `decideIdentity` maps to UNKNOWN `unreadable`. That blocks entries, so it fails closed.
  - A broken client is released with `release(true)` and destroyed. A read that timed out leaves no reused session, and the db test checks `settle(migrated) === 0` after the lock is dropped.
- **Timeout tests** (`test/unit/db/marker-read.spec.ts:56-78`, `test/db/client.db-spec.ts:97-124`):
  - The bounds are `[5000 - 50, 5000 + 2000)` ms around the measured elapsed time, and that time also includes the connect. A Node timer does not fire earlier than its delay, apart from about 1 ms of clock rounding, so the 50 ms lower slack is enough and the test is not flaky on that side.
  - The vitest timeout is 12 s on the unit test and 30 s on the db test, both above the upper bound.
- **Fixtures** (`test/fixtures/fake-postgres.ts`) are a hand-written protocol stub. They are not produced by the code under test.
  - I checked `AuthenticationOk` (`R`, length 8, code 0) and `ReadyForQuery` (`Z`, length 5, `I`) by hand against the v3 protocol.
  - `SSL_REQUEST = 80877103` is correct.
- **D13.** No logic is duplicated and no Python is added.
- **Determinism.** The same server behaviour always gives the same `MarkerRead`, so the identity outcome does not depend on timing beyond the bounded timeout.

### Non-blocking notes

1. The three hand-offs from round 1 still apply to later jobs:
   - D12 µs against ms on server-filled `timestamptz` columns that are compared after a round trip through JS.
   - The schema scan does not cover `PgArray`, `json`/`jsonb` or the integer types.
   - The raw-pool `int8` path has no string assertion.
