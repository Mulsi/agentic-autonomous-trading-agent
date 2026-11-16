# S0g Small fixes (S0f review)

## Goal

Close the three small items the S0f reviews left open. None of them changes trading behaviour or runtime code paths.

1. **`make db-up` never pulls an image that is already local.**
   - The recipe reads the image reference from compose. If Docker already has that image, it starts with `--pull never`. Otherwise it keeps today's pull policy, so a clean checkout still pulls.
   - Background: during S0f a pull of the digest-pinned image hung on `docker-credential-desktop get`, and starting with `--pull never` worked because the image was local.
   - The backlog's `--pull missing` does not achieve this. See "Plan versus repo" below.
2. **The identity property covers failed reads with a `sqlstate`.** The property "is VERIFIED exactly when configured and equal to the single stored marker" in `test/unit/db/identity.spec.ts` also generates failed reads that carry a `sqlstate`. The invariant "a failed read is never VERIFIED" is then pinned directly, not only through the one hand-written case.
3. **The `scrubbedForInspect` comment names its one exception.**
   - The doc comment on `scrubbedForInspect` in `src/config/boot-output.ts` stops saying that getters are never called.
   - An own `stack` accessor on an Error, including a user-defined one, is read once. `inspect` reads it anyway, so this exposes nothing new.
   - The comment is wrong and the code is not.

## Plan references

- Backlog S0g (`factory/backlog.md` line 14). Its sources are the S0f job, `factory/jobs/006-db-client-followups/`:
  - Pull: `build.md`, "First attempt: `make db-up` hung in the Docker credential helper", and `decision.md`, "What a human should check" 3, last bullet.
  - The identity property: `round-1/review-risk.md`, non-blocking note 1. It also suggests the arbitrary to use.
  - The getter comment: `round-1/review-security.md` note 1, and `decision.md` item 1.
- SLICE_1_PLAN:
  - §5 S0 "Done when": `make db-up` passes on a clean checkout.
  - D11: failures are loud. A hung `make db-up` is neither loud nor a failure.
- Master plan:
  - Part I §3, Rule 9: UNKNOWN blocks entries, and VERIFIED comes only from an exact match.
  - Part I §32: no secrets in logs. This is the scrub whose comment is fixed.
  - Part II §24: keep `progress.md` and `tests.json` current.

### Plan versus repo: `--pull missing`

The backlog item says "`make db-up` passes `--pull missing` to `docker compose up`, so an image that is already local is never pulled". The coordinator tested this with Docker Compose v2.38.2, on the machine where the hang happened:

- `docker compose --dry-run -p s0g-pull-probe --env-file /dev/null --file docker-compose.yml up --detach --pull missing` prints `postgres Pulling`, although the image is local.
- The same command with `--pull never` does not pull.
- `missing` is compose's default policy anyway, and the S0f hang happened under it.
- The local image is tagged `postgres:16`, not `16.15`.
  - `docker image inspect 'postgres:16.15@sha256:f9a7…657'` still finds it by digest.
  - Compose does not treat it as present.
- `docker compose --env-file /dev/null --file docker-compose.yml config --images` prints `postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657`.

So `--pull missing` would change nothing. This spec follows the backlog's intent, that an image already local is never pulled, rather than its letter. It does so with a run-time choice: `--pull never` when `docker image inspect` finds the exact reference compose uses, and the default policy otherwise. A bare `--pull never` would break `make db-up` on a clean checkout, against S0's "Done when".

## Scope

### In

- **Makefile (repo root), `db-up` recipe.** These changes go after the existing Docker checks and before `up`, in the same `set -eo pipefail` shell.
  1. **Read the image reference.**
     - Read it with `docker compose --env-file /dev/null --file docker-compose.yml config --images`. `docker-compose.yml` stays the only place the digest is written.
     - Assign it to a shell variable, for example `image`.
     - Check it explicitly, without relying on `set -e` alone. If the command fails, prints nothing, or prints more than one line or anything with whitespace, the target prints a `db-up: ...` message to stderr and exits 1.
     - It must never fall through to `up` or to a pull.
  2. **Choose the pull policy.**
     - Use one `if docker image inspect "$$image" >/dev/null 2>&1; then ... else ... fi`.
     - The `then` branch sets a bash array to `(--pull never)`. The `else` branch sets it to `()`, which leaves today's policy.
  3. **Start Postgres with one `up` command.**
     - Keep exactly one `docker compose ... up` command.
     - It keeps every flag it has today: `--env-file /dev/null --file docker-compose.yml up --detach --wait --wait-timeout 120`.
     - It adds the array expansion, `"$${pull[@]}"`.
     - Nothing else in the recipe changes. The migration step and its messages stay as they are.
  4. **Update the comment above `db-up`.** Add lines saying that an image already present by its exact reference is never pulled, because a pull can hang on Docker's credential helper. Say that `--pull missing` is not enough, because compose still pulls a digest-pinned image whose local tag differs.

  The variable and array names are the builder's choice. The structure (one read, one guard, one `if docker image inspect`, one `up`) is fixed, so the text tests can check it.
- **`test/unit/db/compose.spec.ts`.** Tests that read the Makefile through the existing `parseMakefile` fixture, plus the raw text for the comment. No Docker is involved.
- **`test/unit/db/identity.spec.ts`.**
  - Extend the `read` arbitrary of the existing property with failed reads that carry a `sqlstate`. Use the reviewer's form: `fc.stringMatching(/^[0-9A-Z]{5}$/).map((sqlstate) => ({ kind: 'failed', sqlstate }))`.
  - Count the cases that hit the new branch and assert the count is above zero.
  - The property's expectations and its 2,000 runs stay as they are.
- **`src/config/boot-output.ts`: the doc comment on `scrubbedForInspect` only.**
  - Replace "Getters are copied, never called." with wording that names the exception, for example: "Getters are copied, not called, except an Error's own `stack`, which is read once, as `inspect` reads it."
  - The inline comment at the `stack` branch may be tightened to match.
  - No code change in this file. Not a token outside comments.
- **`test/unit/config/boot-output.inspect.spec.ts`.**
  - Behaviour tests that pin what the new comment says.
  - A text test on the doc comment.
  - The existing test "getters are copied, never called" stays unchanged. It uses a plain object, so it is still true.
- **Housekeeping.**
  - `progress.md`:
    - The `make db-up` bullet under Current state › Database says this: it reads the image reference with `config --images`, starts with `--pull never` when that image is already local, and otherwise pulls as before.
    - A Done line `- [x] S0g Small fixes: ...`.
    - The stale sentence "S0 is complete: S0a to S0e have merged" becomes "S0a to S0g".
  - `tests.json`: update the `covers` text of `compose.spec.ts`, `identity.spec.ts`, `boot-output.inspect.spec.ts` and `repo-files.spec.ts` for the new cases. The text describes the run-time `--pull never` choice, not `--pull missing`. No new spec file is expected. If one is added, it gets an entry.

### Out

- Any change to `scrubbedForInspect`'s behaviour. That includes not calling a user-defined `stack` getter, and adding a getter-safe path. The reviewer found no new exposure, and the backlog asks only for a reword.
- **Compose and image changes.** That covers `pull_policy` in `docker-compose.yml`, retagging the local image, and any other compose, Docker or image-pin change. `docker-compose.yml` is not edited.
- **Live Docker checks.** Running `make db-up` or a compose dry run is not part of this job. The gate runs only `pnpm test`, so this job checks the Makefile text. A human may run `make db-up` with the image local as a smoke check, but no criterion depends on it.
- Changes to `decideIdentity`, `markerReadFailure`, `blocksEntries` or anything else in `src/db/`.
- The other notes from the S0f review: the integer-money convention risk, the raw-SQL `now()` precision and the `numeric[]`/`jsonb` raw-pool hazard. They are already recorded as S1b and S6b in the backlog.
- `package.json`, `pnpm-lock.yaml`, migrations, `factory/`, `.claude/`, `CLAUDE.md` and the plans. The backlog's S0g wording is not edited by this job; the orchestrator owns `factory/`.

## Acceptance criteria

All of these run under `pnpm test`, with no Docker and no database. "The recipe" is `recipes['db-up']` from `parseMakefile(readRepoFile('Makefile'))`.

**Makefile (`test/unit/db/compose.spec.ts`)**

1. **The image read.**
   - The recipe contains exactly one `docker compose --env-file /dev/null --file docker-compose.yml config --images`.
   - It sits inside a command substitution assigned to a shell variable.
   - It comes before the `docker image inspect` and before the `up` command.
2. **The read's guard.** Between the `config --images` read and `docker image inspect`, the recipe has a guard that prints a message starting `db-up:` to stderr (`>&2`) and runs `exit 1`. The read itself is followed by `||` leading to that exit, so a failed read stops the target.
3. **The inspect branch.** The recipe contains exactly one `if docker image inspect "$$image"` with that same variable, quoted, and with its output sent to `/dev/null`.
4. **`--pull never` only when the image is local.**
   - `--pull never` appears exactly once in the recipe.
   - It lies between the `then` of that `if docker image inspect` and the next `else`.
   - The `else` branch sets the pull array to empty and contains no `--pull`.
5. **One `up` command with today's flags.**
   - Exactly one `;`-separated segment of the recipe matches `docker compose … up`.
   - That segment contains `--env-file /dev/null`, `--file docker-compose.yml`, `--detach`, `--wait` and `--wait-timeout 120`, plus the pull array's expansion.
   - It contains no literal `--pull`.
6. **No explicit pull.** The recipe contains no `docker pull`, no `compose pull`, and no `--pull` value other than the one `never` from criterion 4 (no `always`, `missing` or `build`).
7. **The comment.** The comment block directly above the `db-up:` rule in the raw Makefile text mentions `--pull never` and matches `/credential/i`.
8. **Existing Makefile tests.** These still pass unchanged:
   - the DB_URL match in `compose.spec.ts`
   - the research checks in `research.spec.ts`
   - the `parseMakefile` tests in `parsers.spec.ts`

**Identity property (`test/unit/db/identity.spec.ts`)**

9. The property "is VERIFIED exactly when configured and equal to the single stored marker" draws its reads from an arbitrary that includes `{ kind: 'failed', sqlstate }` with `sqlstate` matching `^[0-9A-Z]{5}$`, alongside the existing `no_table`, plain `failed` and `rows` branches.
10. Across the property's runs, a counter of generated reads with `kind === 'failed'` and a `sqlstate` is greater than 0. This is asserted after `fc.assert`.
11. **The rest of the property is unchanged.**
    - It is VERIFIED exactly when the marker is configured and the single stored marker equals it.
    - `result.marker` equals that single marker.
    - It still runs 2,000 times.
    - No other test in the file is loosened or removed.

**The `scrubbedForInspect` comment and behaviour (`test/unit/config/boot-output.inspect.spec.ts`)**

12. An `Error` whose own `stack` is redefined as a user-defined accessor (`Object.defineProperty(err, 'stack', { get, configurable: true })`) has that getter called exactly once by `scrubbedForInspect(err, [secret])`. The getter's return value holds the secret.
13. In the same case, the copy's own `stack` is a data property (no `get`), its value holds `[REDACTED]` and not the secret, and the original error's `stack` descriptor is still the accessor.
14. On that same error, a second user-defined own getter with a name other than `stack` is not called.
15. A plain non-Error object with an own `stack` getter does not have it called.
16. **The comment text.** The `/** … */` block directly before `export function scrubbedForInspect(` in `src/config/boot-output.ts`:
    - no longer contains the sentence `Getters are copied, never called.`
    - has a sentence that matches both `/getter/i` and `` /`stack`/ ``, so the exception is named next to the getter rule
17. **Behaviour unchanged.** The existing `boot-output.inspect.spec.ts`, `boot-output` and `secrets` specs pass unchanged, including "getters are copied, never called". The reviewer confirms from the diff that `boot-output.ts` changes only in comments.

**Housekeeping (`test/unit/tooling/repo-files.spec.ts`)**

18. `progress.md` has a line matching `/^- \[x\] S0g /m`.
19. The Current state › Database subsection contains `--pull never` and `config --images`. It does not contain `--pull missing`.
20. The Next section contains `S0a to S0g`. The existing "says S0 is complete and names S1a as next" test still passes.
21. `tests.json` still lists every spec file exactly once and only files that exist. These are the existing tests.

**Whole job**

22. `pnpm test`, `pnpm lint` and `pnpm typecheck` pass. No test is deleted, skipped or loosened. `package.json`, `pnpm-lock.yaml` and `docker-compose.yml` are untouched.

## Rules that apply

- **Never delete or skip a test to go green.**
  - The identity property is extended, never narrowed. Its expectations and run count stay.
  - "getters are copied, never called" stays as it is.
- **UNKNOWN blocks entries (Rule 9).** The identity property guards "VERIFIED only on an exact match". The change must make it stricter, never weaker, and must not touch `src/db/identity.ts`.
- **No secrets (Part I §32, S0c).** `boot-output.ts` is the failed-boot secret scrub and sits under protected `src/config/`. Only its comment may change. Any code change there is out of scope and would need its own job. This is why the job needs a human.
- **Factory agents never read `.env` and never touch real accounts.**
  - The Makefile change is checked by reading the Makefile text, not by running Docker.
  - `--env-file /dev/null` stays on every compose command, the new `config --images` read included.
- **D11, loud failures.**
  - `db-up` keeps `set -eo pipefail` and its non-zero exits.
  - A failed or malformed `config --images` read stops the target with a message. It never silently falls through to a pull.
  - A clean checkout with no local image still pulls, so S0's "Done when" holds.
- **Write tests first where practical.** Criteria 1 to 4, 7, 10, 16, 18 and 19 fail on today's `main` and should be seen failing before the fix.

## Open decisions

- None from SLICE_1_PLAN §11. No item there bears on this job.
- Choice made here: the `scrubbedForInspect` comment is reworded, and the user-defined `stack` getter is still called. This follows the backlog and the security review, which found no new exposure. Changing the behaviour would be a separate job under `src/config/`.
