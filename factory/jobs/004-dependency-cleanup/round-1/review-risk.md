VERDICT: PASS

## Findings

None blocking.

### Scope

S0d is dependency hygiene. Most of the risk checklist has nothing to inspect here: no order path, no risk engine, no entry gate, no 48-entry counter, no exits, no kill switch, no money values and no order state. No file under `src/` changed (`git diff --name-only main...HEAD` lists none). I reviewed the parts of the change that touch trading safety indirectly:

- **D11, a process that boots.** The engine and every exit need one.
- **D2, no HTTP surface.** An HTTP surface would be an unreviewed way into the process.
- **D9, no secrets and no Anthropic SDK.**
- **Fail-loud behaviour** of `make db-up` and of the esbuild override.

### What I checked and found sound

1. **Boot availability (D11), property test.** `test/unit/config/secrets.property.spec.ts:55-76` runs `loggerOptions(secretValues(settings))` on every accepted value. That is exactly what `src/app.module.ts:16-17` runs at boot. Other details:
   - `settingsFor` (`:25-33`) swallows only a `SettingsError` from `parseSettings`, which is a refusal. Any other error, and any throw from `secretValues` itself, fails the property, so the test swallows nothing it should not.
   - I read zod 4.6.7's `$ZodURL` check. It validates `value.trim()` with WHATWG `URL.parse` and returns that trimmed value with tab, LF and CR removed. `secretValues` re-parses that same string with `new URL`, so the guarantee holds by construction today, and the property locks it in.
   - Both mutations in `build.md` fail the property with a shrunk counterexample:
     - M1, a throw on `%` in the password
     - M2, a regex-only zod rule, which gave `postgres://:@:`

     The worktree was confirmed clean after each revert.
   - The property runs 2,000 times.
2. **HTTP adapter removal does not affect boot.**
   - `src/main.ts:9` uses `NestFactory.createApplicationContext`. In the locked `@nestjs/core@12.4.2`, `nest-factory.js` calls `loadAdapter('@nestjs/platform-express', …)` only from `createHttpAdapter` (line 180), which `create` uses and `createApplicationContext` (line 70) does not.
   - Removing the package therefore cannot break the standalone boot. A future `NestFactory.create` would fail loudly, as D11 wants.
   - The e2e suite in `build.md` passes unchanged: 20 of 20, including the secret-leak and non-paper refusal cases.
   - `test/unit/app/no-telemetry.spec.ts:78-97` resolves from `@nestjs/core`'s installed path, with a `tslib` control, so it would also catch `express` hoisted into `.pnpm/node_modules` by any other package.
3. **No new runtime dependency.**
   - `fast-check` is dev-only, and `dependencies.spec.ts` asserts that.
   - The importers block of `pnpm-lock.yaml` shows the runtime set unchanged except Nest 12.2.0 to 12.4.2.
   - zod, pino, pino-http and nestjs-pino did not move.
   - All 383 package entries carry a `sha512` integrity, with no tarball, git or GitHub source.
4. **The esbuild override** (`pnpm-workspace.yaml:10-11`):
   - It is scoped to `@esbuild-kit/core-utils>esbuild` and adds no new esbuild version.
   - `pnpm db:generate`, `make db-up` (which runs `drizzle-kit migrate`) and `pnpm test:db` all pass under it.
   - A break would surface as a non-zero `make db-up`, not as a silently skipped migration.
5. **The Postgres digest pin** (`docker-compose.yml:14`) changes nothing at runtime beyond fixing the bytes. If the digest ever cannot be pulled, `make db-up` fails non-zero, which `build.md` shows when the credential helper was killed. That is fail-loud, not degraded.
6. **No test weakened.**
   - The compose image rule is stricter.
   - The three removed test names are progress assertions, each with a forward replacement (criterion 28).
   - No `.skip`, `.only` or deleted spec.
   - The `if (overridden)` branch in `dependencies.spec.ts` registers the fallback assertions when the override is absent. Neither branch is a skip.

### Non-blocking notes

1. **D9 has no dedicated unit test for the dependency tree. This gap is older than this job.**
   - Nothing under `test/` asserts that `package.json` or `pnpm-lock.yaml` holds no `@anthropic-ai/sdk`, no `ccxt` and no package whose name contains `binance`.
   - The gate tripwires (`factory/gate.sh:16-17`) match key names, order endpoints, `withdraw`, `sk-ant-` and live mode, but not these package names.
   - This job proves the property only by shell (criterion 8, `build.md`: 0 hits each), and the spec scoped it that way.
   - **Failing scenario.** A later job adds `@anthropic-ai/sdk` or an exchange client to `package.json`, and no test or tripwire fails. Only a reviewer would catch it.
   - **Suggested fix**, in S0e or a small follow-up: a unit test in `test/unit/tooling/dependencies.spec.ts` that reuses `lockedPackages()` and `readPackageJson()` and rejects `@anthropic-ai/sdk`, `ccxt` and `/binance/i` in both. It is not blocking here because the spec assigned criterion 8 to `shell` and the gap predates this diff.
2. **The coverage sample is not seeded** (`secrets.property.spec.ts:78`, `fc.sample` with no seed).
   - `build.md` reports at least 40 hits per shape in each of 50 batches of 2,000, so a zero-hit run is negligible.
   - Any flake would only block a merge, which is the safe direction. No change needed.
