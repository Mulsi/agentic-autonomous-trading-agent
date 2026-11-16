# Build: 007-small-fixes (S0g)

Branch `factory/007-small-fixes`, commit `bd22ef7` ("S0g: small fixes from the S0f reviews"), one commit on top of `c532cd5`.

## What changed

- **`Makefile`, `db-up`.** This goes after the two Docker checks and before `up`, in the same `set -eo pipefail` shell:
  - `image="$$(docker compose --env-file /dev/null --file docker-compose.yml config --images)" || { echo "db-up: ..." >&2; exit 1; }`
  - A guard: `if [ -z "$$image" ] || [[ "$$image" =~ [[:space:]] ]]; then echo "db-up: ..." >&2; exit 1; fi`. Command substitution strips trailing newlines, so two lines leave an inner `\n`, and the whitespace test rejects it.
  - `if docker image inspect "$$image" >/dev/null 2>&1; then pull=(--pull never); else pull=(); fi`
  - The single `up` keeps all of today's flags and adds `"$${pull[@]}"` at the end.
  - The comment above `db-up` now says that a local image is never pulled, because a pull can hang in the credential helper, and that `--pull missing` is not enough.
  - The migration step is unchanged, and `docker-compose.yml` is untouched.
- **`src/config/boot-output.ts`: comments only.**
  - The doc comment on `scrubbedForInspect` now reads: "Getters are copied, not called, except an Error's own `stack`, which is read once, as `inspect` reads it, even when it is a user-defined accessor."
  - The inline comment at the `stack` branch is tightened to match.
  - A diff filter over the changed lines (`^[-+]` minus lines starting `*` or `//`) is empty.
- **Tests.** Added to `compose.spec.ts`, `identity.spec.ts`, `boot-output.inspect.spec.ts` and `repo-files.spec.ts`. No test was removed, skipped or loosened.
- **Housekeeping.**
  - `progress.md`: a `make db-up` sub-bullet under Current state › Database, the `- [x] S0g Small fixes: ...` line, and "S0a to S0g".
  - `tests.json`: S0g text appended to the four `covers` entries. No new spec file.

## Acceptance criteria

All of these are in `pnpm test`. The `compose.spec.ts` tests are in the describe "make db-up never pulls an image that is already local (S0g)".

| # | Proof |
|---|---|
| 1 | `compose.spec.ts`: "reads the image reference from compose exactly once", "assigns the read to a shell variable through a command substitution", "reads the image before docker image inspect and before up" |
| 2 | "stops with a db-up: message on stderr when the read fails" checks that the read is followed by `\|\| { echo "db-up: ..." >&2; exit 1; }`. "stops with a db-up: message on stderr when the read is empty or not one word" checks the `-z` and `[[:space:]]` guard before the `if docker image inspect`. |
| 3 | "has one if docker image inspect on that variable, quoted, output to /dev/null" |
| 4 | "passes --pull never only in the then branch of that if", "leaves the pull array empty in the else branch" |
| 5 | "starts Postgres with one up command, with the flags it had before and the pull array" |
| 6 | "never pulls explicitly, and passes no pull policy but never". Extra test: "passes --env-file /dev/null on every compose command" (exactly two compose commands, both with it). |
| 7 | "says in the comment above db-up why a local image is never pulled" (`--pull never`, `/credential/i`, and `--pull missing`) |
| 8 | Unchanged and passing: "match the URL that make db-up passes to pnpm db:migrate", `research.spec.ts`, `parsers.spec.ts` |
| 9 | `identity.spec.ts`, "is VERIFIED exactly when configured and equal to the single stored marker": the `read` arbitrary adds the reviewer's `fc.stringMatching(/^[0-9A-Z]{5}$/).map(...)` branch |
| 10 | The same test counts `failedWithSqlstate` inside the property and asserts `> 0` after `fc.assert` |
| 11 | The expectations and `numRuns: 2_000` are unchanged, and no other test in the file was edited (see the diff) |
| 12 | `boot-output.inspect.spec.ts`, "scrubbedForInspect reads only an Error's own stack getter (S0g)" › "calls a user-defined own stack getter on an Error exactly once" |
| 13 | › "copies that stack as a scrubbed data property and leaves the original accessor" |
| 14 | › "does not call another own getter on the same Error" (the copy's `detail` descriptor `toStrictEqual`s the original's, so it holds the same getter) |
| 15 | › "does not call an own stack getter on an object that is not an Error" |
| 16 | › "the doc comment names the stack exception next to the getter rule" (the block directly before `export function scrubbedForInspect(`, checked both raw and with its lines joined) |
| 17 | The existing `boot-output*` and `secrets*` specs pass unchanged, including "getters are copied, never called". The `boot-output.ts` diff is comments only. |
| 18 | `repo-files.spec.ts`, "marks S0g done" |
| 19 | "says make db-up passes --pull never only for an image already local (S0g)" |
| 20 | "says S0a to S0g have merged". "says S0 is complete and names S1a as next" still passes. |
| 21 | The existing tests.json tests pass |
| 22 | `pnpm test` (28 files, 720 tests), `pnpm lint` and `pnpm build`, which runs typecheck, all pass. `package.json`, `pnpm-lock.yaml` and `docker-compose.yml` are untouched. |

**Tests first.** I watched the new tests for criteria 1 to 7, 16, 18, 19 and 20 fail before the fix: 12 failed in `compose.spec.ts`, plus the comment test and the 3 progress tests. Criteria 9, 10 and 12 to 15 add coverage of behaviour that already exists, so they passed from the start, as expected.

## Checks beyond `pnpm test`

- **Stub-`docker` run of the recipe** (no real Docker). A stub `docker` placed first on `PATH` logged each call and failed `up`, so the recipe stopped before pnpm. I ran `make db-up` against it with macOS `/bin/bash` 3.2:
  - Image local: `up ... --wait-timeout 120 --pull never`.
  - Image absent: `up` with no `--pull`.
  - Read fails, empty output, two lines, or a value with a space: the target exits with a `db-up:` message, and neither `image inspect` nor `up` runs.
  - The stub and its runner are scratch files, not committed.
- **Live check, done once.**
  - `docker info` answered at once (28.3.2), and no other container was running.
  - From the worktree root, `make db-up` exited 0. Compose created the network, volume and container, waited until healthy, and the migrations applied. **No "Pulling" line appeared.**
  - Then `pnpm test:db` (7 files, 71 tests), `pnpm build` and `pnpm test:e2e` (2 files, 41 tests) all passed.
  - Torn down with `docker compose --env-file /dev/null --file docker-compose.yml down --volumes`, which removed only `007-small-fixes-postgres-1`, `007-small-fixes_pgdata` and `007-small-fixes_default`. No image was retagged or removed, and no other project was touched.
  - Nothing was pulled and I killed no processes.

## `[human]` items

- This job edits the protected `src/config/boot-output.ts`, comments only. A human should confirm from the diff that no token outside comments changed.
- A clean-checkout pull, with the image absent, was not exercised against real Docker, because that would mean removing the image. Only the stub run shows that the `else` branch passes no `--pull`.

## For the reviewer

- `compose.spec.ts` pins a fairly exact text form: the `|| { echo ...; exit 1; }` group, `[ -z "$$image" ]` and `[[ "$$image" =~ [[:space:]] ]]`. The spec fixes the structure, so this is deliberate, but a harmless rewording of the guard will fail these tests.
- The pull array is expanded after `--wait-timeout 120`, which compose accepts (the live run passed it). On bash 3.2, `"${pull[@]}"` on an empty array expands to nothing because `set -u` is not on. If someone later adds `set -u` to this recipe, bash 3.2 will fail on the empty array.
- `progress.md` already says "S0a to S0g have merged", as the spec asks, although S0g merges only after review.
- `pnpm exec prettier --check src test` flags only the generated `src/db/migrations/meta/*.json` files. `main` gives the same result.
