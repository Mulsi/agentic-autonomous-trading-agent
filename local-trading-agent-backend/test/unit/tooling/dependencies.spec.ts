import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  compareVersions,
  lockedOverrides,
  lockedPackages,
  lockedSnapshots,
  lockedVersion,
  readLockfile,
  versionParts,
} from '../../fixtures/lockfile.js';
import { isYamlMap, parseYaml } from '../../fixtures/parsers.js';
import {
  readAppFile,
  readPackageJson,
  readRepoFile,
} from '../../fixtures/repo.js';

const { scripts, dependencies, devDependencies } = readPackageJson();
const STABLE_RANGE = /^[\^~]?\d+\.\d+\.\d+$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

describe('@nestjs/mau and the deploy script are gone', () => {
  it('package.json has no @nestjs/mau', () => {
    expect({ ...dependencies, ...devDependencies }).not.toHaveProperty(
      '@nestjs/mau',
    );
  });

  it('package.json has no deploy script', () => {
    expect(scripts).not.toHaveProperty('deploy');
  });

  it('no script runs nest deploy or mau', () => {
    for (const command of Object.values(scripts)) {
      expect(command).not.toMatch(/\bnest\s+deploy\b|\bmau\b/i);
    }
  });

  it('pnpm-lock.yaml has no @nestjs/mau', () => {
    expect(readLockfile()).not.toContain('@nestjs/mau');
  });

  it('the README has no Deployment section and never says mau', () => {
    const readme = readAppFile('README.md');

    expect(readme).not.toMatch(/^## Deployment\s*$/m);
    expect(readme.toLowerCase()).not.toContain('mau');
  });
});

describe('TypeScript stays inside the typescript-eslint peer range', () => {
  const specifier = devDependencies.typescript ?? '';
  const locked = lockedVersion('typescript') ?? '';

  it('pins typescript with a tilde on a full version', () => {
    expect(specifier).toMatch(/^~\d+\.\d+\.\d+$/);
  });

  it('locks the same major and minor, at or above the pinned patch', () => {
    const pinned = specifier.slice(1);
    const [major, minor] = versionParts(pinned);

    expect(versionParts(locked).slice(0, 2)).toEqual([major, minor]);
    expect(compareVersions(locked, pinned)).toBeGreaterThanOrEqual(0);
  });

  it("the locked typescript satisfies typescript-eslint's peer range", () => {
    // The installed typescript-eslint is the locked one: the gate installs
    // with --frozen-lockfile.
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require.resolve('typescript-eslint/package.json'), 'utf8'),
    ) as { version: string; peerDependencies: Record<string, string> };
    const range = manifest.peerDependencies.typescript ?? '';
    // Only the `>=a <b` form is understood; anything else fails loudly.
    const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range);

    expect(manifest.version).toBe(lockedVersion('typescript-eslint'));
    expect(match, range).not.toBeNull();
    expect(compareVersions(locked, match?.[1] ?? '')).toBeGreaterThanOrEqual(0);
    expect(compareVersions(locked, match?.[2] ?? '')).toBeLessThan(0);
  });
});

describe('pnpm-workspace.yaml', () => {
  const workspace = parseYaml(readAppFile('pnpm-workspace.yaml'));
  const allowBuilds = workspace.allowBuilds;

  it('denies every install script, esbuild among them', () => {
    if (!isYamlMap(allowBuilds)) throw new Error('allowBuilds is not a map');

    expect(Object.keys(allowBuilds)).toContain('esbuild');
    for (const allowed of Object.values(allowBuilds)) {
      expect(allowed).toBe('false');
    }
  });

  it('holds only allowBuilds and overrides', () => {
    for (const key of Object.keys(workspace)) {
      expect(['allowBuilds', 'overrides']).toContain(key);
    }
  });

  it('matches the overrides that pnpm-lock.yaml records', () => {
    expect(workspace.overrides ?? {}).toEqual(lockedOverrides());
  });
});

describe('esbuild advisory GHSA-67mh-4wv8-2f99', () => {
  const OVERRIDE = '@esbuild-kit/core-utils>esbuild';
  const overrides = lockedOverrides();
  const overridden = OVERRIDE in overrides;
  const esbuilds = lockedPackages().filter(({ name }) => name === 'esbuild');
  const snapshots = lockedSnapshots();
  const progress = readRepoFile('progress.md');

  it('progress.md names the advisory and states the decision', () => {
    expect(progress).toContain('GHSA-67mh-4wv8-2f99');
    expect(progress).toContain(
      overridden ? 'esbuild is overridden' : 'esbuild is not overridden',
    );
  });

  it('the lockfile holds esbuild at all', () => {
    expect(esbuilds.length).toBeGreaterThan(0);
  });

  if (overridden) {
    it('no locked esbuild is below 0.25.0', () => {
      for (const { version } of esbuilds) {
        expect(compareVersions(version, '0.25.0')).toBeGreaterThanOrEqual(0);
      }
    });

    it('overrides esbuild only below @esbuild-kit/core-utils', () => {
      const esbuildKeys = Object.keys(overrides).filter((key) =>
        /(^|>)esbuild$/.test(key),
      );

      expect(esbuildKeys).toEqual([OVERRIDE]);
      expect(overrides).not.toHaveProperty('esbuild');
    });

    it('brings in no esbuild that drizzle-kit, tsx or vite do not use', () => {
      const used = new Set(
        snapshots
          .filter(({ name }) => ['drizzle-kit', 'tsx', 'vite'].includes(name))
          .flatMap(({ dependencies: deps }) =>
            deps.esbuild === undefined ? [] : [deps.esbuild],
          ),
      );

      expect(used.size).toBeGreaterThan(0);
      for (const { version } of esbuilds) {
        expect([...used]).toContain(version);
      }
    });
  } else {
    it('only @esbuild-kit/core-utils reaches esbuild below 0.25.0', () => {
      const old = new Set(
        esbuilds
          .filter(({ version }) => compareVersions(version, '0.25.0') < 0)
          .map(({ version }) => version),
      );
      const parents = snapshots
        .filter(({ dependencies: deps }) => old.has(deps.esbuild ?? ''))
        .map(({ name }) => name);

      expect([...new Set(parents)]).toEqual(['@esbuild-kit/core-utils']);
    });

    it('progress.md gives the reason esbuild 0.18.20 stays', () => {
      expect(progress).toMatch(/dev server/);
      expect(progress).toMatch(/serve/);
    });
  }
});

describe('fast-check', () => {
  it('is a devDependency with a stable range and a stable locked version', () => {
    expect(devDependencies['fast-check']).toMatch(STABLE_RANGE);
    expect(lockedVersion('fast-check')).toMatch(STABLE_VERSION);
  });

  it('is not a runtime dependency', () => {
    expect(dependencies).not.toHaveProperty('fast-check');
  });

  it('comes without another property-test library', () => {
    expect(devDependencies).not.toHaveProperty('@fast-check/vitest');
  });
});
