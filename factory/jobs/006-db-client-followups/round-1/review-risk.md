VERDICT: PASS

## Scope

This job does not touch any trading path. It has no order submission, no entry gate, no 48-entry counter, no kill switch, no stops or limits, no Claude call and no exit logic. The only trading-safety surface is the database identity check, which feeds `blocksEntries` (S7a), and the money and time column conventions in the schema scan. I reviewed both against Rule 9 (UNKNOWN blocks entries), D2 (money is never a JS `number`) and D12. I also read the `boot-output.ts` change, but only to check that it cannot crash the boot or change the exit code. Secret scrubbing belongs to the security review.

## What I checked, and why it holds

- **VERIFIED is still reachable from one place only.** `src/db/identity.ts:67-71`: a `failed` read, with or without `sqlstate`, returns UNKNOWN `unreadable` before the rows branch. `stored` is only set for `kind: 'rows'`, so a failed read never carries a marker. `blocksEntries` (`identity.ts:82-84`) is unchanged.
- **Every new failure ends at UNKNOWN, never at a crash.**
  - `markerReadFailure` (`identity.ts:93-108`) catches a throwing `code` getter or proxy and returns a plain `failed`.
  - `markerReadFromRows` (`src/db/marker-rows.ts:17-27`) uses `safeParse` inside a try. Any non-string marker, a missing key, null, an extra or invalid row, or a non-array value gives `failed`, which becomes UNKNOWN `unreadable`. A fast-check property over `fc.anything()` covers this.
  - In `client.ts:115-126` the parse runs inside the existing try, so the `finally` still releases the client.
  - The catches return a fail-safe UNKNOWN and do not swallow the failure. The boot logs it as a `warn` identity line.
- **No new path from server text to the log line (Rule 11).** Only a code that matches `^[0-9A-Z]{5}$` (anchored, no `m` flag) is kept. Message, detail, hint and stack are dropped. A sentinel test covers this in unit and e2e.
- **The boot never fails on the identity, so exits keep running.** `main.ts` is unchanged and still spreads `identityLogFields`.
- **`printBootFailure` still sets `process.exitCode = 1` first** (`boot-output.ts:245`). `inspectScrubbed` and the logger overrides fall back to the old `inspect` path when the copy throws, so a failed boot cannot get stuck without printing.
- **Money (D2).** The schema scan (`test/fixtures/schema-scan.ts`) is now an allow-list that fails closed on any `columnType` it does not know.
  - `PgNumericNumber`, `PgNumericBigInt`, `PgReal`, `PgDoublePrecision`, `PgJson`, `PgJsonb`, `PgBigSerial53` and `PgCustomColumn` are banned.
  - Number-mode `bigint` is allowed only on `*_ms` columns.
  - Arrays are limited to text-like, uuid, boolean and enum elements, so the `numeric[]` raw-pool `parseFloatArray` hazard that `build.md` observed is closed.
  - No type parser changed.
- **D12.** A server-filled `timestamptz` must declare `precision` 0 to 3. The one exemption is pinned, and a stale exemption is reported as a violation.

## Findings

No blocking findings.

Non-blocking notes:

1. `test/unit/db/identity.spec.ts:117-150`: the property "is VERIFIED exactly when configured and equal to the single stored marker" generates `failed` reads only without `sqlstate`. Code inspection and the direct case at "copies sqlstate onto UNKNOWN unreadable" show that a failed read with `sqlstate` is never VERIFIED. The new property at "no result but unreadable ever carries sqlstate" would still pass if such a read returned VERIFIED, because a VERIFIED object has no `sqlstate`. Suggested follow-up: add `fc.stringMatching(/^[0-9A-Z]{5}$/).map(s => ({ kind: 'failed', sqlstate: s }))` to the read arbitrary of the VERIFIED-exactly property. That would pin the invariant directly.
2. `test/fixtures/schema-scan.ts:63-69, 124-128`: `PgInteger` and the other 32-bit integer types pass the scan whatever the column name is. A later job could store money in minor units in one, and the scan would not see it. The spec chose this as Open decision 1, and the convention comment in `src/db/schema.ts` states the rule. Values up to 2^31 are exact in JS, so this is a convention risk and not a precision bug. I note it for the human sign-off. It does not block.
3. Out of scope, recorded for continuity: a stored marker string from a stand-in server still reaches the identity log line on `mismatch`. That behaviour predates this job and is untouched by it.
