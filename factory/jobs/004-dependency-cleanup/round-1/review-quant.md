VERDICT: PASS

## Findings

No blocking findings.

This change has no market data, features, thresholds, fills, EV or money in it. `git diff --name-status main...HEAD` changes nothing under `src/` or `research/`. So the look-ahead, train/test split, survivorship, Wilder smoothing, fill model, EV and Decimal checks do not apply. The only quantitative content is the fast-check property and its generator (`test/fixtures/database-urls.ts`, `test/unit/config/secrets.property.spec.ts`), plus the version comparisons in `test/fixtures/lockfile.ts`. I checked those myself rather than trusting the pasted runs.

### What I verified

1. **The property is sound against zod 4.6.7.** `$ZodURL.check` (`node_modules/.pnpm/zod@4.6.7/.../v4/core/schemas.js:263`) validates `URL.parse(value.trim())` and returns `stripTabAndNewline(trimmed)`. WHATWG deletes every tab, LF and CR before it parses, so `new URL(stripTabAndNewline(t))` behaves exactly like `new URL(t)`. Non-whitespace C0 controls that `trim` leaves at an edge are stripped by WHATWG in both parses. So on today's zod, `secretValues` (`src/config/secrets.ts:48-61`) cannot fail on a value that `parseSettings` returns. The property is a tripwire for a future zod change, as the spec intends. M2 in `build.md` shows that it fires (`postgres://:@:`).

2. **The property body does not swallow the failure it guards.** `settingsFor` (`secrets.property.spec.ts:25-33`) catches `SettingsError` only around `parseSettings`. A `SettingsError` thrown by `secretValues` inside the property (`:67`) propagates and fails `fc.assert`. That matches the M2 trace.

3. **The fixture labels are not produced by the code under test.** Labels come from the generator parts (`database-urls.ts:47-56`). Each passing label is then checked on the WHATWG-parsed URL by an independent predicate (`secrets.property.spec.ts:92-137`). I traced each predicate against the WHATWG userinfo, opaque-host and port rules for the non-special `postgres` scheme. All of them hold:
   - a raw `@` in the password becomes `%40`
   - non-ASCII text becomes `%80`–`%FF` bytes, and lone surrogates become `%EF%BF%BD`
   - an opaque host percent-encodes non-ASCII
   - a non-special scheme has no default port, so `:0`–`:65535` stays visible

4. **Margins and flake risk, measured.** The spec samples without a fixed seed, so every `pnpm test` run draws new values. I ran the generator plus `parseSettings` from the worktree under 300 seeds × 2,000 draws, using scratch scripts outside the repo. Results:
   - **Pass rate:** minimum 0.583, mean 0.615, against the 0.25 threshold.
   - **Passing values with a non-empty password:** at least 672 per seed.
   - **Failing values:** at least 684 per seed.
   - **Rarest passing shapes, per seed:**
     - `edge U+00A0 or U+FEFF`: minimum 137
     - `bracketed IPv6 host`: minimum 150
     - `invalid percent sequence in password`: minimum 198
   - **Rarest `UNPARSEABLE` shapes:** minimum 39, mean about 60 each.
   - **Labels wrong or values accepted that should fail:** none.
     - Across a further 300 seeds (600,000 values), no labelled passing value broke its predicate.
     - No value labelled with an unparseable shape was ever accepted.
     - No accepted value made `secretValues` throw.

   A chance failure of any coverage assertion is therefore on the order of e^-39 or smaller. Not fixing the seed is acceptable, and the spec allows it.

5. **The UNPARSEABLE shapes always fail by construction:**
   - a port of 65536 or more
   - `[` with no `]` before `/`, `?`, `#` or the end
   - a space in an opaque host, which is a forbidden host code point

   The wellFormed password pieces exclude `/`, `?` and `#` (`database-urls.ts:63-65`), so the authority boundary cannot move. This matches the 0 acceptances above.

6. **Run count.** `numRuns: 2_000` (`secrets.property.spec.ts:22,69`) is at least the 1,000 the spec requires. The `runs >= 1_000` assertion is a real counter, not a constant.

7. **`lockfile.ts` version math.** `versionParts` and `compareVersions` (`:223-237`) are integer tuple comparisons on `x.y.z` and throw on anything else. A JS `number` is correct here, because these are versions, not money. `lockedVersion` (`:210-220`) assumes `specifier:` comes before `version:`. If that ever changes, it returns `undefined` and the dependent tests fail loudly rather than misread. The peer-range check (`dependencies.spec.ts:498-504`) accepts only the `>=a <b` form and fails on any other. I confirmed in the committed lockfile:
   - `esbuild` 0.25.12 and 0.28.2 are the only esbuild versions.
   - `@esbuild-kit/core-utils@3.3.2` resolves `esbuild: 0.25.12`.
   - `overrides:` holds only `'@esbuild-kit/core-utils>esbuild': ^0.25.4`.

8. **Data handling and UTC.** The compose `command` keeps `timezone=UTC` and `log_timezone=UTC`, and only the `image:` line and its comment change. There are no timestamp, gap or quarantine paths in the diff. D13 holds: the property is TypeScript, and `research/` is untouched.

### Non-blocking notes

- **Optional fixed seed.** Because no seed is fixed, the property explores new inputs on every run. That is good for finding a zod regression, but it means a real counterexample could first show up in an unrelated job's gate run. fast-check prints the seed and path, so it can be reproduced. If the team prefers gate determinism, a fixed `seed` on the boundary-coverage `fc.sample`, with the property left unseeded, would keep the coverage assertions deterministic without narrowing exploration. The margins in item 4 make this optional.
