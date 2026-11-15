ESCALATE

## Why

The work itself looks sound. Escalation is required by the rules, not by a defect I found.

- `gate.md` says `GATE: PASS` but `NEEDS_HUMAN: yes`. The protected path `local-trading-agent-backend/src/config/boot-output.ts` changed (part C, the secret scrub before `util.inspect`).
- The spec's "Open decisions" section is not empty. It lists five choices that the spec says a human should confirm: the allow-list scan with 32-bit integers allowed, the `json`/`jsonb` ban, the array element types, the `created_at` exemption instead of a migration, and the `sqlstate` field name and regex. The builder took every default.
- On the merits:
  - All 35 acceptance criteria have a named passing test in `build.md`: unit 700/700, db 71/71 after the round 1b fix, e2e 41/41, and lint and build pass.
  - The diff stays in scope. No migration, no `package.json` or lockfile change, no trading path touched.
  - All four reviews PASS, and none of them waved through a concern I think is real.
  - `blocksEntries` is unchanged, `VERIFIED` is still reachable from one place only, and every new failure ends at UNKNOWN `unreadable`.
  - Only a validated 5-character SQLSTATE reaches the log line. Every new path in the scrub falls back to the old inspect-then-text-scrub behaviour, so it is never weaker than before.
  - No risk limit, strategy parameter or money-handling code changed. The schema scan is test-only and stricter than before.

## What a human should check

1. **`src/config/boot-output.ts`, `scrubbedForInspect` (about 140 new lines).** This is the protected change. It copies the value with secrets replaced in its strings, then inspects the copy. Check these parts:
   - how it copies Errors (it rebuilds the prototype and turns `stack` into a plain value)
   - the list of built-ins it passes through unchanged (`passedThrough`). A secret inside a Proxy, Date, Buffer and so on still gets only the old text scrub.
   - the `catch {}` fallbacks, which go back to the original value and then the text scrub
   - the depth cap of 16
   - the `stringifyMessage` and `stringifyParams` overrides on `BootConsoleLogger`

   The tests behind it are the 300-run property with leak-detecting controls, the reviewer's escaping probe and the newline-split case. Security note 1: the doc comment says getters are never called, but a user-defined `stack` getter on an Error subclass is called. `inspect` reads it anyway, so the comment is wrong but nothing new is exposed.
2. **Confirm or override the five open decisions in `spec.md`.** Two of them deserve a second look:
   - Decision 1: `integer` and the other 32-bit types pass the scan under any column name. Money stored as an integer count of minor units would not be caught. Only the comment in `schema.ts` stops it (risk note 2).
   - Decision 4: `database_identity.created_at` keeps microsecond precision under one pinned exemption. The alternative is a migration to `timestamptz(3)`.
3. **Notes from the reviews that later jobs need, which you may want in the backlog:**
   - The D12 precision rule only sees Drizzle defaults. A `now()` written in raw SQL (`INSERT`, `UPDATE` or a trigger) into a plain `timestamptz` brings the same hazard back (quant note 1).
   - A raw-pool query that returns `numeric[]` or `jsonb`, such as `array_agg(price)`, gives JS numbers whatever the column types are (quant note 2).
   - The property that VERIFIED happens only on an exact match never generates a failed read with a `sqlstate`. Adding that would pin the invariant directly (risk note 1).
   - Makefile: add `--pull never` or `--pull missing` to the compose `up` (build.md, the Docker credential-helper hang).
