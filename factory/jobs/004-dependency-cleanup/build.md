# Build: 004 S0d Dependency cleanup

Branch `factory/004-dependency-cleanup`, one commit, `101e23d`, on top of `main` at `b7bd12f`. Nothing was pushed.

## Summary

- **Fresh lockfile.** `pnpm-lock.yaml` is a fresh resolution (lockfile and `node_modules` deleted, then `pnpm install`). Express, `multer`, `cors` and the rest of the HTTP adapter left the tree. Nest moved from 12.2.0 to 12.4.2. The lockfile went from 518 to 383 package entries, and the install from 423 to 309 packages.
- **Removed.** `@nestjs/mau`, the `deploy` script, and the README's Deployment section and Mau bullet.
- **TypeScript.** The specifier is narrowed to `~6.0.3`. typescript-eslint 8.72.1 is locked, and its peer range is `>=4.8.4 <6.1.0`.
- **esbuild (GHSA-67mh-4wv8-2f99).** The override is kept: `'@esbuild-kit/core-utils>esbuild': ^0.25.4` in `pnpm-workspace.yaml`. `esbuild@0.18.20` and its `@esbuild/*@0.18.20` packages are gone. drizzle-kit passes every check under the override, so the fallback was not needed.
- **Postgres image.** It is pinned as `postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657`, the multi-platform OCI image index.
- **Property test.** `fast-check` 4.10.2 is a new devDependency. A new property checks that every `DATABASE_URL` that `parseSettings` accepts gets through `secretValues` and `loggerOptions` without throwing. It passed on zod 4.6.7 before the re-resolve and after it. zod did not move, because 4.6.7 is still the newest 4.x.
- **Audits.**
  - `pnpm audit --prod`: one high advisory (`multer`) on `main`, none on the branch.
  - `pnpm audit`: 26 advisories on `main`, 1 on the branch (`minimatch`, moderate, dev-only, recorded in `progress.md`).
- **Production code.** No file under `src/` changed. The version moves needed no source fix.
- **Gate commands.** `pnpm install --frozen-lockfile`, `pnpm test` (376 tests), `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e` and `pnpm test:db` all exit 0.

No stop condition was hit:
- The property found no counterexample.
- No existing test failed after a version move.
- `pnpm audit --prod` is clean.
- No new package needs an install script.
- The npm registry and Docker Hub were reachable.

## Environment

- Node 26.12.1, pnpm 12.3.4, Docker engine 28.3.2. Network use was limited to reads from the npm registry, its audit endpoint and Docker Hub. I ran no `docker login`, changed no Docker Desktop setting, and never read `.env`. drizzle-kit ran only through the `db:*` scripts.
- **pnpm 12's minimum release age.** pnpm 12 skips versions published in the last day, and prints "Lockfile passes supply-chain policies". I left that setting alone, as the spec requires. You can see its effect in the resolution:
  - vite 8.3.7 was taken. It was published 2026-11-09T10:25Z, 28 h before the resolve.
  - typescript-eslint 8.72.2 was not taken. It was published 2026-11-09T17:08Z, 21 h before. The locked version is 8.72.1.
  - Both 8.72.1 and 8.72.2 declare `typescript >=4.8.4 <6.1.0`.
  - A fresh resolve after 2026-11-10T17:08Z would pick 8.72.2. My scratch re-resolve (criterion 5) ran at 14:33Z and gave a byte-identical lockfile.
- **The Docker Desktop credential helper hangs on this machine.** The first `docker buildx imagetools inspect` and the first `make db-up` both sat in `docker-credential-desktop get` for minutes, probably waiting on a keychain prompt. Those were my own processes, so I stopped them. When the helper was killed, `make db-up` exited non-zero (`error getting credentials`) and created nothing. That matches D11. The cause is the host, not the repo. To work around it without touching any setting, I ran two commands with `DOCKER_CONFIG` pointing at an empty throwaway directory in the scratchpad, which makes the read anonymous:
  - `docker buildx imagetools inspect`, for the digest
  - one `docker pull postgres:16.15@sha256:f9a7…`

  The image bytes were already local: the existing `postgres:16` image carries the same digest. The pull added only the pinned reference, which you can see in `docker images --digests`. After that, every `make db-up` ran unmodified and pulled nothing. On a machine with a working credential helper, none of this is needed.
- **Docker hygiene.** I ran one compose project at a time, and removed each one with `down -v` when I was done:
  1. `004-dependency-cleanup`, the worktree project
  2. `clones0d`, criterion 19
  3. `cloneupgrade`, criterion 20

  I touched no other container, volume or project. Port 55432 was free throughout, and no container is running now. To run `pnpm test:db` in the worktree again, run `make db-up` first.

## What changed

**Repo root**
- `docker-compose.yml`: the image line is now `postgres:16.15@sha256:<index digest>`, with a two-line comment above it. The comment has no `$`. Nothing else changed.
- `progress.md`:
  - S0d marked done, S0e named as next, and "S0e remains open under S0"
  - the Database section covers the digest pin, how to update it, and the recreate-and-keep-the-volume behaviour
  - a Current state bullet for the property
  - a new `### Dependencies` settlement: what was removed, the lockfile, the TypeScript pin, install scripts, the esbuild decision with its fallback, and the remaining advisory
- `tests.json`: two new entries, plus new `covers` text for the four changed specs.

**App folder**
- `package.json`: exactly four changes (criterion 7).
- `pnpm-lock.yaml`: a fresh resolution. Its `overrides:` block holds the one esbuild override.
- `pnpm-workspace.yaml`: `allowBuilds: esbuild: false` is unchanged. The `overrides:` block and its comment are new.
- `README.md`: the `## Deployment` section and the Mau bullet under Resources are gone. The rest is unchanged.

**Tests**

New files:
- `test/unit/tooling/dependencies.spec.ts`: criteria 4, 10, 11, 13, 14 and 21.
- `test/unit/config/secrets.property.spec.ts`: criteria 22 and 23. It lives outside the protected `/src/config/` pattern.
- `test/fixtures/database-urls.ts`: the tagged generator. Every value carries the shape labels of the parts it was built from.
- `test/fixtures/lockfile.ts`: a strict reader for the lockfile's `packages:`, `snapshots:`, `overrides:` and `importers:` sections.

Changed files:
- `test/unit/app/no-telemetry.spec.ts`: criteria 1 and 2. All existing tests stay.
- `test/unit/db/compose.spec.ts`: criterion 16. The image rule now requires a digest. `postgres:16` and `postgres:16.15` moved into the rejected examples, along with uppercase-hex, short, `sha512:` and untagged forms, and two accepted examples were added.
- `test/unit/tooling/repo-files.spec.ts`: the progress assertions move forward, and there are new checks for the digest pin and the Dependencies settlement.
- `test/fixtures/parsers.ts` and `test/unit/tooling/parsers.spec.ts`: `parseYaml` now accepts a single- or double-quoted key with no quote or backslash inside it. The override key `'@esbuild-kit/core-utils>esbuild'` needs this, because YAML cannot start a plain key with `@`. New tests cover reading quoted keys and refusing an escaped, unclosed or duplicate quoted key. All the old refusals still hold.

**Tests first.** I wrote the property and ran it on `main`'s tree (zod 4.6.7) before anything else changed; that run is under criterion 24. The only addition at that point was `fast-check`, added with `pnpm add -D` on `main`'s resolution, so that the property could run. I then wrote the dependency, compose and progress tests and ran them before the implementation. 23 tests failed, each for the expected reason, and nothing else broke:

```text
      Tests  23 failed | 352 passed (375)
 FAIL  test/unit/app/no-telemetry.spec.ts > telemetry and HTTP packages > no locked version carries a @nestjs/platform-express peer suffix
 FAIL  test/unit/app/no-telemetry.spec.ts > telemetry and HTTP packages > pnpm-lock.yaml has no package or snapshot entry for @nestjs/platform-express
 FAIL  test/unit/app/no-telemetry.spec.ts > telemetry and HTTP packages > pnpm-lock.yaml has no package or snapshot entry for cors
 FAIL  test/unit/app/no-telemetry.spec.ts > telemetry and HTTP packages > pnpm-lock.yaml has no package or snapshot entry for express
 FAIL  test/unit/app/no-telemetry.spec.ts > telemetry and HTTP packages > pnpm-lock.yaml has no package or snapshot entry for multer
 FAIL  test/unit/app/no-telemetry.spec.ts > the HTTP adapter cannot be loaded > resolving @nestjs/platform-express from @nestjs/core throws MODULE_NOT_FOUND
 FAIL  test/unit/app/no-telemetry.spec.ts > the HTTP adapter cannot be loaded > resolving express from @nestjs/core throws MODULE_NOT_FOUND
 FAIL  test/unit/db/compose.spec.ts > docker-compose.yml > pins the image by digest
 FAIL  test/unit/db/compose.spec.ts > docker-compose.yml > runs postgres tagged on major version 16
 FAIL  test/unit/tooling/dependencies.spec.ts > @nestjs/mau and the deploy script are gone > no script runs nest deploy or mau
 FAIL  test/unit/tooling/dependencies.spec.ts > @nestjs/mau and the deploy script are gone > package.json has no @nestjs/mau
 FAIL  test/unit/tooling/dependencies.spec.ts > @nestjs/mau and the deploy script are gone > package.json has no deploy script
 FAIL  test/unit/tooling/dependencies.spec.ts > @nestjs/mau and the deploy script are gone > pnpm-lock.yaml has no @nestjs/mau
 FAIL  test/unit/tooling/dependencies.spec.ts > @nestjs/mau and the deploy script are gone > the README has no Deployment section and never says mau
 FAIL  test/unit/tooling/dependencies.spec.ts > TypeScript stays inside the typescript-eslint peer range > pins typescript with a tilde on a full version
 FAIL  test/unit/tooling/dependencies.spec.ts > esbuild advisory GHSA-67mh-4wv8-2f99 > progress.md gives the reason esbuild 0.18.20 stays
 FAIL  test/unit/tooling/dependencies.spec.ts > esbuild advisory GHSA-67mh-4wv8-2f99 > progress.md names the advisory and states the decision
 FAIL  test/unit/tooling/repo-files.spec.ts > progress.md > has a Dependencies settlement
 FAIL  test/unit/tooling/repo-files.spec.ts > progress.md > marks S0a, S0b, S0c and S0d done
 FAIL  test/unit/tooling/repo-files.spec.ts > progress.md > mentions the digest pin in its Database section
 FAIL  test/unit/tooling/repo-files.spec.ts > progress.md > names S0e as next
 FAIL  test/unit/tooling/repo-files.spec.ts > progress.md > says S0e remains open under S0
 FAIL  test/unit/tooling/repo-files.spec.ts > tests.json > lists every spec file exactly once
 Test Files  4 failed | 16 passed (20)
⎯⎯⎯⎯⎯⎯ Failed Tests 23 ⎯⎯⎯⎯⎯⎯⎯
```

(On `main`'s tree with no override, `dependencies.spec.ts` took its fallback branch. That is why "progress.md gives the reason esbuild 0.18.20 stays" appears in that list.)

## Dependency moves (criterion 6)

`pnpm list --depth 0`, `main` against the branch. Both list 27 direct dependencies: `@nestjs/mau` went out and `fast-check` came in.

```diff
3,4c3,4
< ├── @nestjs/common@12.2.0
< ├── @nestjs/core@12.2.0
---
> ├── @nestjs/common@12.4.2
> ├── @nestjs/core@12.4.2
16,19c16,18
< ├── @nestjs/cli@12.0.10
< ├── @nestjs/mau@0.2.9
< ├── @nestjs/schematics@12.0.10
< ├── @nestjs/testing@12.2.0
---
> ├── @nestjs/cli@12.0.12
> ├── @nestjs/schematics@12.0.13
> ├── @nestjs/testing@12.4.2
25a25
> ├── fast-check@4.10.2
30c30
< ├── vite@8.3.5
---
> ├── vite@8.3.7
```

Package counts:

| | `main` | branch |
|---|---|---|
| `packages:` entries in `pnpm-lock.yaml` | 518 | 383 |
| `snapshots:` entries in `pnpm-lock.yaml` | 518 | 383 |
| packages installed on darwin-arm64 (`node_modules/.pnpm`) | 423 | 309 |

Every move is a minor or patch inside the existing range. There is no new major and no downgrade:
- zod stays 4.6.7, pino 10.4.0, nestjs-pino 5.3.1, pino-http 11.0.0 and `@types/node` 24.19.2.
- TypeScript stays 6.0.3, and typescript-eslint stays 8.72.1, for the release-age reason given above.

## Audit (criterion 3)

`pnpm audit --prod` on `main`, before any change:

```text
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ multer vulnerable to Denial of Service via a pending asynchronous fileFilter after request teardown │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ multer                                                                                              │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=2.0.0 <2.5.0                                                                                      │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=2.5.0                                                                                             │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/core>@nestjs/platform-express>multer                                                      │
│                     │                                                                                                     │
│                     │ .>nestjs-pino>@nestjs/core>@nestjs/platform-express>multer                                          │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-q7qp-rjg7-q26m                                                   │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────┘
1 vulnerabilities found
Severity: 1 high
exit=1
```

`pnpm audit --prod` on the branch:

```text
No known vulnerabilities found
exit=0
```

`pnpm audit` on `main` found 26 advisories: 5 low, 12 moderate and 9 high. By path:

| Advisories | Path | Fate |
|---|---|---|
| 21 `undici` | `.>@nestjs/mau>undici` | gone with `@nestjs/mau` |
| 2 `tmp` (GHSA-ph9p-34f9-6g65, GHSA-52f5-9888-hmc6) | `.>@nestjs/mau>inquirer>external-editor>tmp` | gone with `@nestjs/mau` |
| 1 `multer` (GHSA-q7qp-rjg7-q26m, high) | `.>@nestjs/core>@nestjs/platform-express>multer` | gone with the fresh resolution |
| 1 `esbuild` (GHSA-67mh-4wv8-2f99) | `.>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild` | gone with the override |
| 1 `minimatch` (GHSA-g3hv-75wg-m249) | `.>@eslint/js>eslint>minimatch` and 35 more | **remains**, see below |

<details><summary>Full <code>pnpm audit</code> output on <code>main</code></summary>

```text
┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ high                │ Undici: Malicious WebSocket 64-bit length overflows parser and crashes the client │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                            │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=6.0.0 <6.24.0                                                                   │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.24.0                                                                          │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-f269-vfmq-vjvj                                 │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ Undici has Unbounded Memory Consumption in WebSocket permessage-deflate Decompression │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.24.0                                                                               │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.24.0                                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                  │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-vrm6-8vpv-qv8q                                     │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ Undici has Unhandled Exception in WebSocket Client Due to Invalid server_max_window_bits Validation │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                              │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.24.0                                                                                             │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.24.0                                                                                            │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                                │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-v9p9-hfj2-hcw8                                                   │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ tmp                                                                                 │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <0.2.6                                                                              │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=0.2.6                                                                             │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>inquirer>external-editor>tmp                                          │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-ph9p-34f9-6g65                                   │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ high                │ undici vulnerable to Denial of Service via unrequested WebSocket subprotocol │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                       │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=6.7.0 <6.28.1                                                              │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.28.1                                                                     │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                         │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-rfgv-xxqx-mfg5                            │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ multer vulnerable to Denial of Service via a pending asynchronous fileFilter after request teardown │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ multer                                                                                              │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=2.0.0 <2.5.0                                                                                      │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=2.5.0                                                                                             │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>nestjs-pino>@nestjs/core>@nestjs/platform-express>multer                                          │
│                     │                                                                                                     │
│                     │ .>@nestjs/core>@nestjs/platform-express>multer                                                      │
│                     │                                                                                                     │
│                     │ .>@nestjs/testing>@nestjs/core>@nestjs/platform-express>multer                                      │
│                     │                                                                                                     │
│                     │ ... Found 4 paths, run `pnpm why multer` for more information                                       │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-q7qp-rjg7-q26m                                                   │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ undici vulnerable to TLS certificate validation bypass via dropped tls options in Agent │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                  │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=4.0.0 <6.29.1                                                                         │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.29.1                                                                                │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                    │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-2m5v-pch6-74hx                                       │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│ high                │ undici vulnerable to Denial of Service via TLS 1.2 certificate-changing renegotiation │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=4.2.1 <6.29.1                                                                       │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.29.1                                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                  │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-qrxm-fqhp-jwvm                                     │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ high                │ undici WebSocket client vulnerable to denial of service via fragment count bypass │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                            │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.27.0                                                                           │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.27.0                                                                          │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-vxpw-j846-p89q                                 │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────┐
│ moderate            │ Use of Insufficiently Random Values in undici     │
├─────────────────────┼───────────────────────────────────────────────────┤
│ Package             │ undici                                            │
├─────────────────────┼───────────────────────────────────────────────────┤
│ Vulnerable versions │ >=6.0.0 <6.21.1                                   │
├─────────────────────┼───────────────────────────────────────────────────┤
│ Patched versions    │ >=6.21.1                                          │
├─────────────────────┼───────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                              │
├─────────────────────┼───────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-c76h-2ccp-4975 │
└─────────────────────┴───────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ esbuild enables any website to send any requests to the development server and read the response │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ esbuild                                                                                          │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=0.24.2                                                                                         │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=0.25.0                                                                                         │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild                            │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-67mh-4wv8-2f99                                                │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ Undici has an unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                                                               │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.23.0                                                                                                                              │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.23.0                                                                                                                             │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                                                                 │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-g9mf-h72j-4rw9                                                                                    │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────┐
│ moderate            │ Undici has an HTTP Request/Response Smuggling issue │
├─────────────────────┼─────────────────────────────────────────────────────┤
│ Package             │ undici                                              │
├─────────────────────┼─────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.24.0                                             │
├─────────────────────┼─────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.24.0                                            │
├─────────────────────┼─────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                │
├─────────────────────┼─────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-2mjp-6q6p-2qxm   │
└─────────────────────┴─────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────┐
│ moderate            │ Undici has CRLF Injection in undici via `upgrade` option │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Package             │ undici                                                   │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.24.0                                                  │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.24.0                                                 │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                     │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-4992-7rv2-5pvq        │
└─────────────────────┴──────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici vulnerable to HTTP header injection via Set-Cookie percent-decoding │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                     │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.27.0                                                                    │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.27.0                                                                   │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                       │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-p88m-4jfj-68fv                          │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici vulnerable to downstream response desynchronization via retry interceptor │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                           │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.28.0                                                                          │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.28.0                                                                         │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                             │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-8xcm-r25x-g524                                │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici vulnerable to CRLF Injection via blob-like body 'type' property │
├─────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                 │
├─────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.28.0                                                                │
├─────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.28.0                                                               │
├─────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                   │
├─────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-m8rv-5g2x-5cg5                      │
└─────────────────────┴────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici vulnerable to cookie attribute injection via unsanitized domain and unparsed setCookie fields │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                               │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.28.0                                                                                              │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.28.0                                                                                             │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                                 │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-v3r7-h72x-cjcm                                                    │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici vulnerable to Denial of Service via unbounded memory in the EventSource parser │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=6.5.0 <6.29.1                                                                       │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.29.1                                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                  │
├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-4qv8-2p9j-2685                                     │
└─────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────┐
│ moderate            │ undici WebSocket client vulnerable to Denial of Service via unbounded automatic PONG buffering │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                         │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=5.15.0 <6.29.1                                                                               │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.29.1                                                                                       │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                           │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-9fm3-97px-rjf6                                              │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬───────────────────────────────────────────────────────────────────────┐
│ moderate            │ minimatch has potential denial of service via globparts amplification │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Package             │ minimatch                                                             │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=7.0.0 <11.0.1                                                       │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=11.0.1                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@eslint/js>eslint>minimatch                                         │
│                     │                                                                       │
│                     │ .>@eslint/js>eslint>@eslint/config-array>minimatch                    │
│                     │                                                                       │
│                     │ .>eslint>minimatch                                                    │
│                     │                                                                       │
│                     │ ... Found 36 paths, run `pnpm why minimatch` for more information     │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-g3hv-75wg-m249                     │
└─────────────────────┴───────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
│ low                 │ tmp allows arbitrary temporary file / directory write via symbolic link `dir` parameter │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ tmp                                                                                     │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=0.2.3                                                                                 │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=0.2.4                                                                                 │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>inquirer>external-editor>tmp                                              │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-52f5-9888-hmc6                                       │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────┐
│ low                 │ undici Denial of Service attack via bad certificate data │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Package             │ undici                                                   │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=6.0.0 <6.21.2                                          │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.21.2                                                 │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                     │
├─────────────────────┼──────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-cxrh-j4jr-qwg3        │
└─────────────────────┴──────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────┐
│ low                 │ undici vulnerable to Set-Cookie SameSite attribute downgrade via permissive substring matching │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                                         │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.27.0                                                                                        │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.27.0                                                                                       │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                                           │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-g8m3-5g58-fq7m                                              │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────────────────────────────┐
│ low                 │ undici vulnerable to HTTP response queue poisoning via keep-alive socket reuse │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                         │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.27.0                                                                        │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.27.0                                                                       │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                           │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-35p6-xmwp-9g52                              │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│ low                 │ undici vulnerable to downstream response splitting via retry interceptor │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Package             │ undici                                                                   │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <6.28.1                                                                  │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.28.1                                                                 │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>@nestjs/mau>undici                                                     │
├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-r53p-7pc4-xj5r                        │
└─────────────────────┴──────────────────────────────────────────────────────────────────────────┘
26 vulnerabilities found
Severity: 5 low | 12 moderate | 9 high
exit=1
```

</details>

`pnpm audit` on the branch:

```text
┌─────────────────────┬───────────────────────────────────────────────────────────────────────┐
│ moderate            │ minimatch has potential denial of service via globparts amplification │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Package             │ minimatch                                                             │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=7.0.0 <11.0.1                                                       │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Patched versions    │ >=11.0.1                                                              │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ Paths               │ .>eslint-config-prettier>eslint>minimatch                             │
│                     │                                                                       │
│                     │ .>eslint-config-prettier>eslint>@eslint/config-array>minimatch        │
│                     │                                                                       │
│                     │ .>typescript-eslint>eslint>minimatch                                  │
│                     │                                                                       │
│                     │ ... Found 35 paths, run `pnpm why minimatch` for more information     │
├─────────────────────┼───────────────────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-g3hv-75wg-m249                     │
└─────────────────────┴───────────────────────────────────────────────────────────────────────┘
1 vulnerabilities found
Severity: 1 moderate
exit=1
```

## Remaining advisories, next to `progress.md` (criterion 30)

| `pnpm audit` on the branch | `progress.md`, Settlements > Dependencies > "Advisories that remain" |
|---|---|
| `minimatch`, vulnerable `>=7.0.0 <11.0.1`, patched `>=11.0.1`, GHSA-g3hv-75wg-m249, moderate. Paths: `.>eslint-config-prettier>eslint>minimatch`, `.>eslint-config-prettier>eslint>@eslint/config-array>minimatch`, `.>typescript-eslint>eslint>minimatch`, "... Found 35 paths". | `minimatch` 10.2.6, GHSA-g3hv-75wg-m249 (glob pattern amplification), moderate. Paths: `eslint>minimatch`, `eslint>@eslint/config-array>minimatch` and `typescript-eslint>@typescript-eslint/typescript-estree>minimatch`. Why it stays: it is dev-only lint tooling. The fix is in minimatch 11, outside the `^10` ranges that eslint 10.14, `@eslint/config-array` 0.23 and `@typescript-eslint/typescript-estree` 8.72 declare, and 10.2.6 is the newest 10.x. The patterns come only from the committed ESLint config and the `eslint src test` arguments. Revisit when eslint moves to minimatch 11. |

The three paths in `progress.md` are the lockfile's own dependency edges to `minimatch@10.2.6`: `eslint`, `@eslint/config-array` and `@typescript-eslint/typescript-estree`. The audit's 36 paths are the routes from the root to those three. `@nestjs/cli` uses `minimatch@11.0.5`, which is patched.

| Package | Declared range | Newest version in range |
|---|---|---|
| eslint 10.14.0 | `^10.2.6` | 10.2.6 |
| `@eslint/config-array` 0.23.5 | `^10.2.4` | 10.2.6 |
| `@typescript-eslint/typescript-estree` 8.72.1 | `^10.2.2` | 10.2.6 |

That is every advisory `pnpm audit` reports, and each one is accounted for.

## `no-telemetry.spec.ts`: covers text next to its tests (criterion 30)

The old `covers` text was "telemetry and HTTP packages removed from package.json, lockfile, source and README". It overstated the file: the lockfile check covered only `@nestjs/observe`, and the source and README check only `@nestjs/observe` and `OBSERVE_` (S0a decision item 9).

The new `covers` text:

> package.json has no @nestjs/observe, @nestjs/platform-express, supertest, @types/supertest or @types/express; pnpm-lock.yaml never mentions @nestjs/observe, has no package or snapshot entry for @nestjs/platform-express, express, multer, cors, supertest, @types/express or @types/supertest, and no @nestjs/platform-express peer suffix; src, test and the README never mention @nestjs/observe or OBSERVE_; @nestjs/platform-express and express fail to resolve from @nestjs/core with MODULE_NOT_FOUND, while tslib resolves

| Claim in `covers` | Test names (`vitest list`) |
|---|---|
| package.json has no @nestjs/observe, @nestjs/platform-express, supertest, @types/supertest or @types/express | `telemetry and HTTP packages > package.json has no @nestjs/observe`, `... no @nestjs/platform-express`, `... no supertest`, `... no @types/supertest`, `... no @types/express` |
| pnpm-lock.yaml never mentions @nestjs/observe | `telemetry and HTTP packages > pnpm-lock.yaml has no @nestjs/observe` (a substring check on the whole file) |
| pnpm-lock.yaml has no package or snapshot entry for the seven HTTP packages | `telemetry and HTTP packages > pnpm-lock.yaml has no package or snapshot entry for @nestjs/platform-express`, `... express`, `... multer`, `... cors`, `... supertest`, `... @types/express`, `... @types/supertest` |
| no @nestjs/platform-express peer suffix | `telemetry and HTTP packages > no locked version carries a @nestjs/platform-express peer suffix` |
| src, test and the README never mention @nestjs/observe or OBSERVE_ | `telemetry and HTTP packages > src, test and the README never mention it` (the regex is `/OBSERVE_\|@nestjs\/observe/`) |
| @nestjs/platform-express and express fail to resolve from @nestjs/core with MODULE_NOT_FOUND | `the HTTP adapter cannot be loaded > resolving @nestjs/platform-express from @nestjs/core throws MODULE_NOT_FOUND`, `... resolving express from @nestjs/core throws MODULE_NOT_FOUND` |
| while tslib resolves | `the HTTP adapter cannot be loaded > resolves tslib, a real dependency of @nestjs/core (control)` |

The text claims nothing about the README or source beyond `@nestjs/observe`, and nothing about `node_modules` beyond what resolving from `@nestjs/core` shows.

## Acceptance criteria

| # | Tag | Proof |
|---|---|---|
| 1 | unit | `no-telemetry.spec.ts`: "pnpm-lock.yaml has no package or snapshot entry for %s" (7 packages) and "no locked version carries a @nestjs/platform-express peer suffix". The existing `package.json` checks stay. The lockfile still names `@nestjs/platform-express` four times, but only as the declared optional peer in the `peerDependencies` and `peerDependenciesMeta` of `@nestjs/core` and `@nestjs/testing`. That is metadata, not an entry or a suffix. |
| 2 | unit | `no-telemetry.spec.ts` "the HTTP adapter cannot be loaded": `createRequire(require.resolve('@nestjs/core')).resolve(...)` throws `MODULE_NOT_FOUND` for `@nestjs/platform-express` and `express`. In the control test, `tslib` resolves. |
| 3 | shell | See [Audit](#audit-criterion-3): `main` has 1 high (`multer`), the branch has none. |
| 4 | unit | `dependencies.spec.ts` "@nestjs/mau and the deploy script are gone", five tests. |
| 5 | shell | See [Lockfile](#lockfile-criteria-5-8-9). Byte-identical. |
| 6 | shell | See [Dependency moves](#dependency-moves-criterion-6). |
| 7 | shell | See [Lockfile](#lockfile-criteria-5-8-9). |
| 8 | shell | See [Lockfile](#lockfile-criteria-5-8-9): 383 of 383 with `sha512` integrity, and none of the forbidden packages. |
| 9 | shell | See [Lockfile](#lockfile-criteria-5-8-9): "No peer dependency issues found". |
| 10 | unit | `dependencies.spec.ts` "TypeScript stays inside the typescript-eslint peer range": the tilde specifier, the same major and minor at or above the pinned patch, and the locked version inside the installed typescript-eslint's peer range. |
| 11 | unit | `dependencies.spec.ts` "pnpm-workspace.yaml > denies every install script, esbuild among them". There are also checks that the file holds only `allowBuilds` and `overrides`, and that its overrides match the lockfile's. |
| 12 | shell | See [Install scripts](#install-scripts-criterion-12). |
| 13 | unit | `dependencies.spec.ts` "progress.md names the advisory and states the decision" (`esbuild is overridden`). |
| 14 | unit | `dependencies.spec.ts`: "no locked esbuild is below 0.25.0", "overrides esbuild only below @esbuild-kit/core-utils" and "brings in no esbuild that drizzle-kit, tsx or vite do not use". The last one reads the dependency edges in `snapshots:`. The fallback tests are written too, and run only when the override is absent. |
| 15 | shell | See [esbuild decision](#esbuild-decision-criterion-15). The fallback was not taken. |
| 16 | unit | `compose.spec.ts`: "runs postgres tagged on major version 16", "pins the image by digest", "the image check accepts %s" (2) and "the image check rejects %s" (11, including `postgres:16` and `postgres:16.15`). The other compose tests are unchanged and pass. |
| 17 | shell | See [Postgres image](#postgres-image-criteria-17-18). |
| 18 | db | `pnpm test:db` against the worktree project, started from the pinned image: 12 of 12 pass, including "runs major version 16" and "uses UTC". |
| 19 | shell | See [Clean clone](#clean-clone-criterion-19). |
| 20 | shell | See [Upgrade path](#upgrade-path-criterion-20). |
| 21 | unit | `dependencies.spec.ts` "fast-check": a stable range and locked version, not in `dependencies`, and no `@fast-check/vitest`. |
| 22 | unit | `secrets.property.spec.ts` "the DATABASE_URL generator reaches the boundary" draws 2,000 values. At least a quarter pass; some passing value has a non-empty password; some value fails. Each of the 13 passing shapes occurs, and is confirmed on the parsed URL itself. The 3 `UNPARSEABLE_DATABASE_URLS` shapes occur, and each value carrying one fails. |
| 23 | unit | `secrets.property.spec.ts` "neither secretValues nor the logger options throw (2000 runs)": `fc.assert` with `numRuns: 2000`, and a counter asserts at least 1,000 runs. |
| 24 | shell | See [Property runs](#property-runs-criterion-24). |
| 25 | shell | See [Mutation checks](#mutation-checks-criterion-25). |
| 26 | shell | See [Final tree](#final-tree-criterion-26). |
| 27 | e2e | `pnpm build && pnpm test:e2e`: 20 of 20, unchanged. See [Final tree](#final-tree-criterion-26). |
| 28 | shell | See [Test names](#test-names-criterion-28). |
| 29 | unit | `repo-files.spec.ts` "progress.md": "marks S0a, S0b, S0c and S0d done", "names S0e as next", "says S0e remains open under S0", "mentions the digest pin in its Database section" and "has a Dependencies settlement". |
| 30 | shell | See the two sections above. |
| 31 | unit | `repo-files.spec.ts` "tests.json > lists every spec file exactly once" (the existing test). It passes with 23 entries. |
| 32 | shell | See [Job boundaries](#job-boundaries-criterion-32). |
| 33 | shell | The orchestrator runs it. My own scan finds no protected path, no tripwire hit, and no skipped or deleted test. |

There are no `[human]` criteria, and none that I could not prove.

## Lockfile (criteria 5, 7, 8, 9)

**How it was produced.** In the worktree I ran `rm -rf node_modules pnpm-lock.yaml && pnpm install`. That resolved `package.json` and `pnpm-workspace.yaml` from scratch. I did not hand-edit the lockfile, and I did not use `pnpm remove`.

```text
$ rm -rf node_modules pnpm-lock.yaml && pnpm install
Progress: resolved 0, reused 1, downloaded 0, added 0
[WARN] 2 deprecated subdependencies found: @esbuild-kit/core-utils@3.3.2, @esbuild-kit/esm-loader@2.6.5
Downloading @rolldown/binding-darwin-arm64@1.2.18: 0.00 B/8.02 MB
Packages are cloned from the content-addressable store to the virtual store.
  Content-addressable store is at: ~/Library/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Packages: +309
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 309, reused 262, downloaded 47, added 309, done

dependencies:
+ @nestjs/common 12.4.2
+ @nestjs/core 12.4.2
+ drizzle-orm 0.45.4
+ nestjs-pino 5.3.1
+ pg 8.23.1
+ pino 10.4.0
+ pino-http 11.0.0
+ reflect-metadata 0.2.2
+ rxjs 7.8.2
+ zod 4.6.7

devDependencies:
+ @eslint/js 10.0.1
+ @nestjs/cli 12.0.12
+ @nestjs/schematics 12.0.13
+ @nestjs/testing 12.4.2
+ @types/node 24.19.2
+ @types/pg 8.23.1
+ @vitest/coverage-v8 4.1.12
+ drizzle-kit 0.31.11
+ eslint 10.14.0
+ eslint-config-prettier 10.1.8
+ fast-check 4.10.2
+ prettier 3.9.10
+ source-map-support 0.5.21
+ typescript 6.0.3
+ typescript-eslint 8.72.1
+ vite 8.3.7
+ vitest 4.1.12

Done in 1.7s using pnpm v12.3.4
exit=0
```

**Criterion 5.** Next I made a scratch copy holding only `package.json` and `pnpm-workspace.yaml`, with no lockfile and no `node_modules`, and ran `pnpm install --lockfile-only` there:

```text
2026-11-10T14:33:07Z
$ ls
package.json
pnpm-workspace.yaml
$ pnpm install --lockfile-only
[WARN] 2 deprecated subdependencies found: @esbuild-kit/core-utils@3.3.2, @esbuild-kit/esm-loader@2.6.5
Done in 118ms using pnpm v12.3.4
exit=0
committed lockfile package keys: 383   scratch lockfile package keys: 383
diff of the two key sets: (empty)
cmp pnpm-lock.yaml <scratch>/pnpm-lock.yaml: identical (byte for byte)
```

There is no difference to explain. A re-run after 2026-11-10T17:08Z would differ by typescript-eslint 8.72.2, which will then be older than pnpm's one-day minimum release age. That version was published before both runs; it only ages past the threshold later.

**Criterion 7:**

```diff
$ git diff main...HEAD -- local-trading-agent-backend/package.json
diff --git a/local-trading-agent-backend/package.json b/local-trading-agent-backend/package.json
index 14d0163..04b5a1a 100644
--- a/local-trading-agent-backend/package.json
+++ b/local-trading-agent-backend/package.json
@@ -13,7 +13,6 @@
     "build": "pnpm typecheck && nest build",
     "db:generate": "DOTENV_CONFIG_PATH=/dev/null drizzle-kit generate",
     "db:migrate": "DOTENV_CONFIG_PATH=/dev/null drizzle-kit migrate",
-    "deploy": "nest deploy",
     "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
     "start": "nest start --env-file ../.env",
     "start:dev": "nest start --watch --env-file ../.env",
@@ -43,7 +42,6 @@
   "devDependencies": {
     "@eslint/js": "^10.0.1",
     "@nestjs/cli": "^12.0.0",
-    "@nestjs/mau": "^0.2.6",
     "@nestjs/schematics": "^12.0.0",
     "@nestjs/testing": "^12.0.1",
     "@types/node": "^24.0.0",
@@ -52,9 +50,10 @@
     "drizzle-kit": "^0.31.11",
     "eslint": "^10.14.0",
     "eslint-config-prettier": "^10.1.8",
+    "fast-check": "^4.10.2",
     "prettier": "^3.4.2",
     "source-map-support": "^0.5.21",
-    "typescript": "^6.0.2",
+    "typescript": "~6.0.3",
     "typescript-eslint": "^8.72.1",
     "vite": "^8.0.0",
     "vitest": "^4.1.2"
```

That is four changes:
1. `@nestjs/mau` removed
2. `deploy` removed
3. `fast-check` added under `devDependencies`
4. `typescript` narrowed

Every other line is unchanged. `fast-check` sits where `pnpm add` put it, in alphabetical order.

**Criterion 8:**

```text
package entries: 383
with resolution: {integrity: sha512-...}: 383
resolution lines of any kind: 383
tarball: 0
git or github sources: 0
@anthropic-ai/sdk: 0
ccxt: 0
binance (any case): 0
```

**Criterion 9:**

```text
$ pnpm peers check
No peer dependency issues found
exit=0
```

## Install scripts (criterion 12)

This is a fresh clone of the branch with no `node_modules`, under `env -i HOME="$HOME" PATH=/usr/bin:/bin`.

There are two proofs that no lifecycle script ran:
- The install prints no script line, and `.modules.yaml` records `esbuild: false` with `pendingBuilds: []`.
- esbuild's `postinstall` (`node install.js`) replaces the `bin/esbuild` JS shim with the native binary. Both copies still hold the shim.

```text
commit: 101e23d  node_modules present: no
$ pnpm install --frozen-lockfile
✓ Lockfile passes supply-chain policies (verified 13m ago)
Lockfile is up to date, resolution step is skipped
Packages are cloned from the content-addressable store to the virtual store.
  Content-addressable store is at: ~/Library/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Packages: +309
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 309, reused 309, downloaded 0, added 309, done

dependencies:
+ @nestjs/common 12.4.2
+ @nestjs/core 12.4.2
+ drizzle-orm 0.45.4
+ nestjs-pino 5.3.1
+ pg 8.23.1
+ pino 10.4.0
+ pino-http 11.0.0
+ reflect-metadata 0.2.2
+ rxjs 7.8.2
+ zod 4.6.7

devDependencies:
+ @eslint/js 10.0.1
+ @nestjs/cli 12.0.12
+ @nestjs/schematics 12.0.13
+ @nestjs/testing 12.4.2
+ @types/node 24.19.2
+ @types/pg 8.23.1
+ @vitest/coverage-v8 4.1.12
+ drizzle-kit 0.31.11
+ eslint 10.14.0
+ eslint-config-prettier 10.1.8
+ fast-check 4.10.2
+ prettier 3.9.10
+ source-map-support 0.5.21
+ typescript 6.0.3
+ typescript-eslint 8.72.1
+ vite 8.3.7
+ vitest 4.1.12

Done in 969ms using pnpm v12.3.4
exit=0
$ grep -A3 pendingBuilds/allowBuilds node_modules/.modules.yaml
  "pendingBuilds": [],
  "allowBuilds": {
    "esbuild": false
  }
$ head -c 64 of each esbuild bin/esbuild (the postinstall would replace the JS shim with the native binary)
esbuild@0.25.12/node_modules/esbuild: a /usr/bin/env node script text executab | #!/usr/bin/env node
esbuild@0.28.2/node_modules/esbuild: a /usr/bin/env node script text executab | #!/usr/bin/env node
```

Every installed package that declares an install script is listed below. esbuild is the only one, as before, so no new package needed a denial:

```text
$ installed packages whose package.json declares preinstall, install or postinstall
esbuild@0.25.12 postinstall: node install.js
esbuild@0.28.2 postinstall: node install.js
```

## esbuild decision (criterion 15)

The override is kept. The lockfile now holds only `esbuild@0.25.12` (drizzle-kit, and `@esbuild-kit/core-utils` through the override) and `esbuild@0.28.2` (tsx and vite). Both versions were in `main`'s lockfile already, so no new esbuild entered. The 22 `@esbuild/*@0.18.20` platform packages and `esbuild@0.18.20` are gone; the lockfile no longer contains `0.18.20` at all.

drizzle-kit's CLI (`bin.cjs`) requires `esbuild` directly, loads the config through its bundled tsx, and never references `@esbuild-kit`. So the override does not touch the code path that drizzle-kit runs.

With the final lockfile:

```text
$ grep -A1 "^overrides:" pnpm-lock.yaml
overrides:
  '@esbuild-kit/core-utils>esbuild': ^0.25.4
$ ls node_modules/.pnpm | grep -E "^esbuild@|^@esbuild\+darwin-arm64@"
@esbuild+darwin-arm64@0.25.12
@esbuild+darwin-arm64@0.28.2
esbuild@0.25.12
esbuild@0.28.2
$ git status --porcelain -- src/db
$ pnpm db:generate
$ DOTENV_CONFIG_PATH=/dev/null drizzle-kit generate
No config path provided, using default 'drizzle.config.ts'
Reading config file '<repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend/drizzle.config.ts'
0 tables


No schema changes, nothing to migrate 😴
exit=0
$ git status --porcelain -- src/db
(lines: 0)
```

- `pnpm test` exits 0 with 376 of 376, which includes `test/unit/db/migrate-env.spec.ts`.
- `pnpm test:db` exits 0 with 12 of 12.
- `make db-up` exits 0.

All three are pasted below.

## Postgres image (criteria 17, 18)

The tag `16.15` resolves to the pinned digest. It is an OCI image index and lists `linux/amd64` and `linux/arm64/v8`. I ran this at pin time:

```text
2026-11-10T14:37:56Z
$ docker buildx imagetools inspect docker.io/library/postgres:16.15 | head -4
Name:      docker.io/library/postgres:16.15
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
           
$ docker buildx imagetools inspect docker.io/library/postgres:16.15 | grep Platform: (attestations are unknown/unknown)
  Platform:    linux/amd64
  Platform:    linux/arm/v5
  Platform:    linux/arm/v7
  Platform:    linux/arm64/v8
  Platform:    linux/386
  Platform:    linux/ppc64le
  Platform:    linux/riscv64
  Platform:    linux/s390x
$ docker buildx imagetools inspect docker.io/library/postgres:16 | head -3
Name:      docker.io/library/postgres:16
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
$ docker buildx imagetools inspect --raw docker.io/library/postgres:16.15 | mediaType
application/vnd.oci.image.index.v1+json
linux/amd64 linux/arm/v5 linux/arm/v7 linux/arm64/v8 linux/386 linux/ppc64le linux/riscv64 linux/s390x
```

The anonymous pull, needed because of the credential helper (see [Environment](#environment)):

```text
$ DOCKER_CONFIG=<empty scratch dir> DOCKER_HOST=unix://$HOME/.docker/run/docker.sock docker pull postgres:16.15@sha256:f9a7b9eb...029657
docker.io/library/postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657: Pulling from library/postgres
Digest: sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
Status: Image is up to date for postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
docker.io/library/postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
exit=0
$ docker images --digests postgres
REPOSITORY   TAG         DIGEST                                                                    IMAGE ID       CREATED       SIZE
postgres     16          sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657   9fded1618a50   5 days ago    474MB
postgres     12-alpine   sha256:76685db4bc5175623bc5d8fa68d6c9ba548aeccd764158709b781ba3c37b8d44   02864e6e5867   2 years ago   243MB
```

`make db-up` in the worktree, then `pnpm test:db` against it (criterion 18):

```text
$ make db-up   (worktree, project 004-dependency-cleanup)
 Network 004-dependency-cleanup_default  Creating
 Network 004-dependency-cleanup_default  Created
 Volume "004-dependency-cleanup_pgdata"  Creating
 Volume "004-dependency-cleanup_pgdata"  Created
 Container 004-dependency-cleanup-postgres-1  Creating
 Container 004-dependency-cleanup-postgres-1  Created
 Container 004-dependency-cleanup-postgres-1  Starting
 Container 004-dependency-cleanup-postgres-1  Started
 Container 004-dependency-cleanup-postgres-1  Waiting
 Container 004-dependency-cleanup-postgres-1  Healthy
✓ Lockfile passes supply-chain policies (verified 10m ago)
Lockfile is up to date, resolution step is skipped
Done in 74ms using pnpm v12.3.4
$ DOTENV_CONFIG_PATH=/dev/null drizzle-kit migrate
No config path provided, using default 'drizzle.config.ts'
Reading config file '<repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend/drizzle.config.ts'
Using 'pg' driver for database querying
[⣷] applying migrations...[✓] migrations applied successfully!make db-up exit=0
```

```text
$ docker inspect --format "{{.Config.Image}}" 004-dependency-cleanup-postgres-1
postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
$ docker image inspect --format "{{json .RepoDigests}}" $(docker inspect --format "{{.Image}}" 004-dependency-cleanup-postgres-1)
["postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657"]
$ pnpm test:db
$ vitest run --config ./vitest.config.db.ts --reporter=verbose

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > exits 0 1ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > records exactly one row in drizzle's migrations table 10ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > creates nothing outside drizzle's bookkeeping schema 10ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > the inventory does see drizzle's own table 7ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > prints neither the URL nor its password 0ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate on a throwaway database > a second run exits 0 and leaves the same single row 358ms
 ✓ test/db/migrate.db-spec.ts > withTestDatabase against the server > drops the database even when the body throws 30ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero when DATABASE_URL is unset 147ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero on a wrong password, applies nothing, and hides it 440ms
 ✓ test/db/migrate.db-spec.ts > pnpm db:migrate failures > exits non-zero when no server listens on the port, and hides the password 328ms
 ✓ test/db/server.db-spec.ts > the compose Postgres server > runs major version 16 2ms
 ✓ test/db/server.db-spec.ts > the compose Postgres server > uses UTC 2ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  15:42:44
   Duration  2.08s (transform 22ms, setup 0ms, import 53ms, tests 1.89s, environment 0ms)

exit=0
```

## Clean clone (criterion 19)

This is a fresh clone of the branch at `<scratchpad>/clean room/clone s0d`, a path with a space, with no `node_modules` and no `.env`, under `env -i HOME="$HOME" PATH=/usr/bin:/bin`:

```text
path: <scratchpad>/clean room/clone s0d
commit: 101e23d  node_modules present: no  .env present: no
PATH=/usr/bin:/bin  node on PATH: none  pnpm on PATH: none  docker on PATH: none
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make db-up
 Network clones0d_default  Creating
 Network clones0d_default  Created
 Volume "clones0d_pgdata"  Creating
 Volume "clones0d_pgdata"  Created
 Container clones0d-postgres-1  Creating
 Container clones0d-postgres-1  Created
 Container clones0d-postgres-1  Starting
 Container clones0d-postgres-1  Started
 Container clones0d-postgres-1  Waiting
 Container clones0d-postgres-1  Healthy
✓ Lockfile passes supply-chain policies (verified 14m ago)
Lockfile is up to date, resolution step is skipped
Packages are cloned from the content-addressable store to the virtual store.
  Content-addressable store is at: ~/Library/pnpm/store/v11
  Virtual store is at:             node_modules/.pnpm
Packages: +309

dependencies:

devDependencies:

Done in 482ms using pnpm v12.3.4
$ DOTENV_CONFIG_PATH=/dev/null drizzle-kit migrate
No config path provided, using default 'drizzle.config.ts'
Reading config file '<scratchpad>/clean room/clone s0d/local-trading-agent-backend/drizzle.config.ts'
Using 'pg' driver for database querying
[⣷] applying migrations...[✓] migrations applied successfully!
make db-up exit=0
$ docker inspect --format "{{.Config.Image}}" clones0d-postgres-1
postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
$ docker image inspect --format "{{json .RepoDigests}}" <the container image ID>
["postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657"]
pinned in docker-compose.yml: sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
$ docker exec clones0d-postgres-1 psql -U trader -d trader -Atc "show server_version"
16.15 (Debian 16.15-1.pgdg13+2)
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make test
$ vitest run
 Test Files  20 passed (20)
make test exit=0
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make lint
$ eslint src test
make lint exit=0
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make typecheck
$ tsc --noEmit -p tsconfig.json
make typecheck exit=0
$ pnpm test:db   (clone, project clones0d)
 ✓ test/db/migrate.db-spec.ts (10 tests) 1876ms
     ✓ a second run exits 0 and leaves the same single row  382ms
     ✓ exits non-zero on a wrong password, applies nothing, and hides it  403ms
     ✓ exits non-zero when no server listens on the port, and hides the password  357ms
 ✓ test/db/server.db-spec.ts (2 tests) 22ms
 Test Files  2 passed (2)
      Tests  12 passed (12)
exit=0
$ git status --porcelain
(lines: 0)
```

Afterwards I removed the `clones0d` project with `docker compose --env-file /dev/null --file docker-compose.yml down -v`. Its container, network and volume are gone.

## Upgrade path (criterion 20)

This ran in a scratch clone at `<scratchpad>/clean room/clone upgrade`, compose project `cloneupgrade`:
1. Check out `main` and run `make db-up`.
2. Check out the branch and run `make db-up`.

Compose recreated the container on the pinned digest; the container ID went from `086f00345718` to `5fecaac76613`. The same volume, created at 14:47:57Z, and the same single migration row `1|1794241128437|734` remain.

```text
### step 1: main
commit: b7bd12f (main)  image line: image: postgres:16
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make db-up
 Network cloneupgrade_default  Creating
 Network cloneupgrade_default  Created
 Volume "cloneupgrade_pgdata"  Creating
 Volume "cloneupgrade_pgdata"  Created
 Container cloneupgrade-postgres-1  Creating
 Container cloneupgrade-postgres-1  Created
 Container cloneupgrade-postgres-1  Starting
 Container cloneupgrade-postgres-1  Started
 Container cloneupgrade-postgres-1  Waiting
 Container cloneupgrade-postgres-1  Healthy
[⣷] applying migrations...[✓] migrations applied successfully!
make db-up exit=0
container: 086f00345718  image: postgres:16
$ psql: select id, created_at, xmin from drizzle.__drizzle_migrations
1|1794241128437|734
volume cloneupgrade_pgdata created 2026-11-10T14:47:57Z

### step 2: the branch
commit: 101e23d (factory/004-dependency-cleanup)  image line: image: postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
$ env -i HOME="$HOME" PATH=/usr/bin:/bin make db-up
 Container cloneupgrade-postgres-1  Recreate
 Container cloneupgrade-postgres-1  Recreated
 Container cloneupgrade-postgres-1  Starting
 Container cloneupgrade-postgres-1  Started
 Container cloneupgrade-postgres-1  Waiting
 Container cloneupgrade-postgres-1  Healthy
Packages: +64 -201
[⣷] applying migrations...[✓] migrations applied successfully!
make db-up exit=0

### step 3: after
container: 5fecaac76613  image: postgres:16.15@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
image RepoDigests: ["postgres@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657"]
mounts: cloneupgrade_pgdata -> /var/lib/postgresql/data
$ psql: select id, created_at, xmin from drizzle.__drizzle_migrations
1|1794241128437|734
$ psql: select count(*) from drizzle.__drizzle_migrations
1
volume cloneupgrade_pgdata created 2026-11-10T14:47:57Z
volumes in project: cloneupgrade_pgdata 
$ docker compose --env-file /dev/null --file docker-compose.yml down -v
 Container cloneupgrade-postgres-1  Stopping
 Container cloneupgrade-postgres-1  Stopped
 Container cloneupgrade-postgres-1  Removing
 Container cloneupgrade-postgres-1  Removed
 Network cloneupgrade_default  Removing
 Volume cloneupgrade_pgdata  Removing
 Volume cloneupgrade_pgdata  Removed
 Network cloneupgrade_default  Removed
exit=0
containers left: 0  volumes left: 0
```

## Property runs (criterion 24)

The first run is on `main`'s tree before the re-resolve, with zod 4.6.7. The only change at that point was `fast-check`, added with `pnpm add -D`.

```text
$ git log -1 --format=%h  (tree: main + fast-check only, before the re-resolve)
b7bd12f
$ node -p "require('zod/package.json').version"
4.6.7
$ pnpm exec vitest run test/unit/config/secrets.property.spec.ts --reporter=verbose

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ✓ test/unit/config/secrets.property.spec.ts > secretValues on every DATABASE_URL that parseSettings accepts > neither secretValues nor the logger options throw (2000 runs) 32ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > draws 2000 values, at least 1,000 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > a quarter or more of them pass parseSettings 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > some passing value has a non-empty password 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > some value fails parseSettings 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "edge ASCII whitespace or C0 control" occurs among the passing values, and holds for each 4ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "edge U+00A0 or U+FEFF" occurs among the passing values, and holds for each 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "tab, LF or CR inside" occurs among the passing values, and holds for each 3ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "percent-encoded password" occurs among the passing values, and holds for each 3ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "invalid percent sequence in password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "raw @ in password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "non-ASCII password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "bracketed IPv6 host" occurs among the passing values, and holds for each 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "non-ASCII host" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "explicit port" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "scheme postgres" occurs among the passing values, and holds for each 4ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "scheme postgresql" occurs among the passing values, and holds for each 4ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "upper-case scheme" occurs among the passing values, and holds for each 5ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "port out of range" occurs, and always fails 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "unclosed IPv6 bracket" occurs, and always fails 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "space in host" occurs, and always fails 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > fully random strings are part of the mix 0ms

 Test Files  1 passed (1)
      Tests  22 passed (22)
   Start at  15:28:59
   Duration  788ms (transform 34ms, setup 0ms, import 638ms, tests 69ms, environment 0ms)

exit=0
```

The second run is after the re-resolve. zod is still 4.6.7, the newest 4.x the resolution would take; a re-resolve never moved it.

```text
$ git log -1 --format=%h  (after the re-resolve)
101e23d
$ node -p "require('zod/package.json').version"
4.6.7
$ grep -A2 '^      zod:' pnpm-lock.yaml
      zod:
        specifier: ^4.6.7
        version: 4.6.7
$ pnpm exec vitest run test/unit/config/secrets.property.spec.ts --reporter=verbose

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ✓ test/unit/config/secrets.property.spec.ts > secretValues on every DATABASE_URL that parseSettings accepts > neither secretValues nor the logger options throw (2000 runs) 32ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > draws 2000 values, at least 1,000 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > a quarter or more of them pass parseSettings 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > some passing value has a non-empty password 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > some value fails parseSettings 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "edge ASCII whitespace or C0 control" occurs among the passing values, and holds for each 4ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "edge U+00A0 or U+FEFF" occurs among the passing values, and holds for each 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "tab, LF or CR inside" occurs among the passing values, and holds for each 3ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "percent-encoded password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "invalid percent sequence in password" occurs among the passing values, and holds for each 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "raw @ in password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "non-ASCII password" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "bracketed IPv6 host" occurs among the passing values, and holds for each 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "non-ASCII host" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "explicit port" occurs among the passing values, and holds for each 2ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "scheme postgres" occurs among the passing values, and holds for each 3ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "scheme postgresql" occurs among the passing values, and holds for each 3ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the shape "upper-case scheme" occurs among the passing values, and holds for each 4ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "port out of range" occurs, and always fails 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "unclosed IPv6 bracket" occurs, and always fails 1ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > the UNPARSEABLE_DATABASE_URLS shape "space in host" occurs, and always fails 0ms
 ✓ test/unit/config/secrets.property.spec.ts > the DATABASE_URL generator reaches the boundary > fully random strings are part of the mix 0ms

 Test Files  1 passed (1)
      Tests  22 passed (22)
   Start at  15:45:11
   Duration  637ms (transform 46ms, setup 0ms, import 502ms, tests 64ms, environment 0ms)

exit=0
```

## Mutation checks (criterion 25)

Each mutation was applied, the property ran, and `git checkout -- src/config` reverted it. The worktree was clean afterwards. In the output, "21 skipped" is vitest's `-t` filter, not a skip in the code.

**M1.** `secretValues` throws when the password contains `%`.

```text
$ git diff -- src/config
diff --git a/local-trading-agent-backend/src/config/secrets.ts b/local-trading-agent-backend/src/config/secrets.ts
index 0587834..81d77f9 100644
--- a/local-trading-agent-backend/src/config/secrets.ts
+++ b/local-trading-agent-backend/src/config/secrets.ts
@@ -16,6 +16,7 @@ export const REDACTED = '[REDACTED]';
 export function secretValues(settings: Settings): string[] {
   const url = settings.DATABASE_URL;
   const password = passwordOf(url);
+  if (password.includes('%')) throw new Error('M1: password contains %');
   if (password === '') return [];
 
   const forms = [url, password];
$ pnpm exec vitest run test/unit/config/secrets.property.spec.ts -t "throw"

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ❯ test/unit/config/secrets.property.spec.ts (22 tests | 1 failed | 21 skipped) 5ms
     × neither secretValues nor the logger options throw (2000 runs) 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/unit/config/secrets.property.spec.ts > secretValues on every DATABASE_URL that parseSettings accepts > neither secretValues nor the logger options throw (2000 runs)
Error: Property failed after 1 tests
{ seed: 1374691795, path: "0:0:0:0:1:1:1:1:1:1:1:1:1:1:1:1", endOnFailure: true }
Counterexample: [{"value":"\u0000postgres://:%C3%BC@.a.aa","shapes":["edge ASCII whitespace or C0 control","scheme postgres","percent-encoded password","non-ASCII host"]}]
Shrunk 15 time(s)

Hint: Enable verbose mode in order to have the list of all failing values encountered during the run
 ❯ buildError ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2469:16
 ❯ throwIfFailed ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2476:8
 ❯ reportRunDetails ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2492:14
 ❯ Module.assert ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2662:7
 ❯ test/unit/config/secrets.property.spec.ts:59:8
     57|     let accepted = 0;
     58|
     59|     fc.assert(
       |        ^
     60|       fc.property(databaseUrls, ({ value }) => {
     61|         runs += 1;

Caused by: Error: M1: password contains %
 ❯ secretValues src/config/secrets.ts:19:37
 ❯ test/unit/config/secrets.property.spec.ts:67:23
 ❯ Property.predicate ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:1355:99
 ❯ Property.run ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:1324:24
 ❯ propertyExecution ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2549:23
 ❯ run ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2639:91
 ❯ runIt ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2542:15
 ❯ check ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2655:14
 ❯ Module.assert ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2660:14
 ❯ test/unit/config/secrets.property.spec.ts:59:8

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Start at  15:45:21
   Duration  575ms (transform 26ms, setup 0ms, import 482ms, tests 5ms, environment 0ms)

exit=1
$ git checkout -- src/config && git status --porcelain
(lines: 0)
```

**M2.** The `DATABASE_URL` rule is replaced by `z.string().regex(/^postgres(ql)?:\/\/.+$/)`.

```text
$ git diff -- src/config
diff --git a/local-trading-agent-backend/src/config/settings.ts b/local-trading-agent-backend/src/config/settings.ts
index 8b7b713..c8dab59 100644
--- a/local-trading-agent-backend/src/config/settings.ts
+++ b/local-trading-agent-backend/src/config/settings.ts
@@ -3,7 +3,7 @@ import { z } from 'zod';
 // The app holds no Anthropic credential (D9). Any variable not named here,
 // including an Anthropic key in the parent environment, is dropped unread.
 export const settingsSchema = z.object({
-  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, hostname: /./ }),
+  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+$/),
   TRADER_MODE: z.literal('paper'),
 });
 
$ pnpm exec vitest run test/unit/config/secrets.property.spec.ts -t "throw"

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ❯ test/unit/config/secrets.property.spec.ts (22 tests | 1 failed | 21 skipped) 7ms
     × neither secretValues nor the logger options throw (2000 runs) 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/unit/config/secrets.property.spec.ts > secretValues on every DATABASE_URL that parseSettings accepts > neither secretValues nor the logger options throw (2000 runs)
Error: Property failed after 191 tests
{ seed: 347151981, path: "190:0:0", endOnFailure: true }
Counterexample: [{"value":"postgres://:@:","shapes":["near miss"]}]
Shrunk 2 time(s)

Hint: Enable verbose mode in order to have the list of all failing values encountered during the run
 ❯ buildError ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2469:16
 ❯ throwIfFailed ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2476:8
 ❯ reportRunDetails ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2492:14
 ❯ Module.assert ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2662:7
 ❯ test/unit/config/secrets.property.spec.ts:59:8
     57|     let accepted = 0;
     58|
     59|     fc.assert(
       |        ^
     60|       fc.property(databaseUrls, ({ value }) => {
     61|         runs += 1;

Caused by: SettingsError: Invalid settings: DATABASE_URL
 ❯ passwordOf src/config/secrets.ts:50:35
 ❯ secretValues src/config/secrets.ts:18:20
 ❯ test/unit/config/secrets.property.spec.ts:67:23
 ❯ Property.predicate ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:1355:99
 ❯ Property.run ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:1324:24
 ❯ propertyExecution ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2549:23
 ❯ run ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2639:91
 ❯ runIt ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2542:15
 ❯ check ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2655:14
 ❯ Module.assert ../../../../Local%20Trading%20agent/.worktrees/004-dependency-cleanup/local-trading-agent-backend/node_modules/.pnpm/fast-check@4.10.2/node_modules/fast-check/lib/fast-check.js:2660:14

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { invalidKeys: [ 'DATABASE_URL' ] }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Start at  15:45:31
   Duration  583ms (transform 25ms, setup 0ms, import 495ms, tests 7ms, environment 0ms)

exit=1
$ git checkout -- src/config && git status --porcelain
(lines: 0)
```

M2's counterexample, `postgres://:@:`, passes the regex, but `new URL` refuses it: the host is empty. That is exactly the gap between zod and the WHATWG parser that the property guards.

## Final tree (criterion 26)

These ran in the worktree at `101e23d`, against the worktree's compose project:

```text
commit: 101e23d
$ pnpm install --frozen-lockfile
✓ Lockfile passes supply-chain policies (verified 12m ago)
Lockfile is up to date, resolution step is skipped
Done in 9ms using pnpm v12.3.4
pnpm install --frozen-lockfile exit=0
$ pnpm test
$ vitest run

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend


 Test Files  20 passed (20)
      Tests  376 passed (376)
   Start at  15:44:53
   Duration  1.38s (transform 432ms, setup 0ms, import 3.66s, tests 1.59s, environment 1ms)

pnpm test exit=0
$ pnpm lint
$ eslint src test
pnpm lint exit=0
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json
pnpm typecheck exit=0
$ pnpm build
$ pnpm typecheck && nest build
$ tsc --noEmit -p tsconfig.json
pnpm build exit=0
$ pnpm test:e2e --reporter=verbose
$ vitest run --config ./vitest.config.e2e.ts --reporter=verbose

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend

 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > exits 0 by itself within the limit 1ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > writes only JSON lines with level, msg and a UTC time 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > routes Nest's own boot lines through pino 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > logs one startup line with the mode and a UUID correlationId 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with valid env > writes neither fixture secret 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > the valid env holds only DATABASE_URL and TRADER_MODE 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > exits 0 by itself when the environment holds a key 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js and ANTHROPIC_API_KEY (D9) > writes the key to neither stdout nor stderr 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js and the database > boots and exits 0 without connecting 0ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=live without leaking secrets 167ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=testnet without leaking secrets 167ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses TRADER_MODE=PAPER without leaking secrets 186ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with invalid env > refuses to start when TRADER_MODE is unset 170ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses a port out of range without leaking the password 167ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses an unclosed IPv6 bracket without leaking the password 168ms
 ✓ test/app.e2e-spec.ts > node dist/main.js with an unparseable DATABASE_URL > refuses a space in the host without leaking the password 167ms
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > exits 0 with nothing on stderr 0ms
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes only clean JSON lines to stdout 1ms
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > passes Nest's buffered boot lines through the same logger 0ms
 ✓ test/app.e2e-spec.ts > the built AppModule scrubs secret values from its logs > writes [REDACTED] where each secret was 0ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  15:44:59
   Duration  2.01s (transform 16ms, setup 0ms, import 22ms, tests 1.92s, environment 0ms)

pnpm test:e2e --reporter=verbose exit=0
$ pnpm test:db
$ vitest run --config ./vitest.config.db.ts

 RUN  v4.1.12 <repo>/.worktrees/004-dependency-cleanup/local-trading-agent-backend


 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  15:45:01
   Duration  1.99s (transform 18ms, setup 0ms, import 44ms, tests 1.81s, environment 0ms)

pnpm test:db exit=0
```

## Test names (criterion 28)

`vitest list` on `main` and on the branch, for each config:

| Config | `main` | branch | Removed | Added |
|---|---|---|---|---|
| `vitest.config.ts` | 308 | 376 | 3 | 71 |
| `vitest.config.e2e.ts` | 20 | 20 | 0 | 0 |
| `vitest.config.db.ts` | 12 | 12 | 0 | 0 |

The only names removed are the three progress assertions that moved forward:

| Removed (`main`) | Replacement (branch) |
|---|---|
| `progress.md > marks S0a, S0b and S0c done` | `progress.md > marks S0a, S0b, S0c and S0d done` |
| `progress.md > names S0d as next` | `progress.md > names S0e as next` |
| `progress.md > says S0d remains open under S0` | `progress.md > says S0e remains open under S0` |

The 71 added tests by file:

| File | Added |
|---|---|
| `no-telemetry.spec.ts` | 11 |
| `secrets.property.spec.ts` | 22 |
| `compose.spec.ts` | 10 |
| `dependencies.spec.ts` | 19 |
| `parsers.spec.ts` | 4 |
| `repo-files.spec.ts` | 5 |

That includes the two new progress assertions.

## Job boundaries (criterion 32)

```text
$ git diff --name-only main...HEAD
docker-compose.yml
local-trading-agent-backend/README.md
local-trading-agent-backend/package.json
local-trading-agent-backend/pnpm-lock.yaml
local-trading-agent-backend/pnpm-workspace.yaml
local-trading-agent-backend/test/fixtures/database-urls.ts
local-trading-agent-backend/test/fixtures/lockfile.ts
local-trading-agent-backend/test/fixtures/parsers.ts
local-trading-agent-backend/test/unit/app/no-telemetry.spec.ts
local-trading-agent-backend/test/unit/config/secrets.property.spec.ts
local-trading-agent-backend/test/unit/db/compose.spec.ts
local-trading-agent-backend/test/unit/tooling/dependencies.spec.ts
local-trading-agent-backend/test/unit/tooling/parsers.spec.ts
local-trading-agent-backend/test/unit/tooling/repo-files.spec.ts
progress.md
tests.json
$ git diff --name-status --diff-filter=D main...HEAD
(lines: 0)
$ protected-path check (gate PROTECTED pattern)
(protected hits: 0)
$ tripwire scan of added lines in non-test, non-.md, non-lockfile files
scanned: docker-compose.yml  hits: 0
scanned: local-trading-agent-backend/package.json  hits: 0
scanned: local-trading-agent-backend/pnpm-workspace.yaml  hits: 0
scanned: tests.json  hits: 0
$ skip/only scan of added test lines
0
```

Every listed file is one the spec allows. No `src/` file changed, so there is none to name. Nothing is listed under `factory/`, `.claude/`, `src/config/`, `src/db/` or `research/`. `.env.example`, the `Makefile`, `CLAUDE.md` and the plan documents are untouched, and no spec file was deleted.

## For reviewers

1. **The generator** (`test/fixtures/database-urls.ts`):
   - Each value is tagged with the shapes it was built from.
   - The coverage test re-checks every passing shape on the parsed URL. For example, "raw @ in password" requires `%40` in `url.password`, so a wrong label fails the test instead of inflating coverage.
   - Near-misses keep only their own labels: a near-miss can parse with the parts split differently.
   - Some near-misses do pass `parseSettings`. One example is `/` in the password with an empty first half. That is useful boundary coverage, not a bug.
   - The sample is not seeded. Across 50 batches of 2,000, every shape occurred at least 40 times among the values it applies to, and at least 59% of values passed. In 20 repeated runs of the spec, 20 passed.
   - Shrinking works through `map`, so counterexamples shrink only partly; M1's kept a leading U+0000.
2. **Visible non-ASCII literals** in the generator (`ü`, `日本`, `пароль`, `münchen.de` and so on) are intentional. Every invisible character (U+00A0, U+FEFF, the other Unicode spaces, U+200B, U+180E) is written as a `\u` escape.
3. **The property** checks only what the spec asks: `secretValues` and `loggerOptions` do not throw. It does not assert that the scrub catches every form of every generated password. That would be a stronger claim about `src/config/`, and a failure there would need a human.
4. **`dependencies.spec.ts` uses a plain `if (overridden)`** to pick the override tests or the fallback tests, as criterion 14 describes. Only one set is registered at a time. This is not `.skip`, and the gate's scan finds none.
5. **The typescript-eslint peer check** reads the installed `typescript-eslint/package.json`, first asserting that its version equals the locked one. It understands only the `>=a <b` form, and fails loudly on any other.
6. **The lockfile reader** in `test/fixtures/lockfile.ts` duplicates the small `lockedVersion` helper that `drizzle.spec.ts` keeps locally. I left `drizzle.spec.ts` untouched to keep the diff to this job.
7. **`compose.spec.ts`** keeps the major-16 tag rule from criterion 16, so it would accept `postgres:16@sha256:…` without a minor version. The file itself uses `16.15`, as the spec's Scope asks.
8. **Docker:** the credential-helper workaround described under [Environment](#environment). The pinned image reference now exists in this machine's Docker image store.
