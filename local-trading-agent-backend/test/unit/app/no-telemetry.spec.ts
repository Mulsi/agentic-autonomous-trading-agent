import { createRequire } from 'node:module';
import { relative } from 'node:path';
import {
  lockedPackages,
  lockedSnapshots,
  readLockfile,
} from '../../fixtures/lockfile.js';
import {
  appRoot,
  listAppFiles,
  readAppFile,
  readPackageJson,
} from '../../fixtures/repo.js';

const REMOVED_PACKAGES = [
  '@nestjs/observe',
  '@nestjs/platform-express',
  'supertest',
  '@types/supertest',
  '@types/express',
];

// D2: no HTTP server in slice 1. These left the installed tree in S0d, where
// they sat only as a stale resolution of @nestjs/core's optional peer. W2
// brings HTTP back in its own job.
const HTTP_PACKAGES = [
  '@nestjs/platform-express',
  'express',
  'multer',
  'cors',
  'supertest',
  '@types/express',
  '@types/supertest',
];

describe('telemetry and HTTP packages', () => {
  it.each(REMOVED_PACKAGES)('package.json has no %s', (name) => {
    const { dependencies, devDependencies } = readPackageJson();

    expect({ ...dependencies, ...devDependencies }).not.toHaveProperty(name);
  });

  it('pnpm-lock.yaml has no @nestjs/observe', () => {
    expect(readAppFile('pnpm-lock.yaml')).not.toContain('@nestjs/observe');
  });

  it.each(HTTP_PACKAGES)(
    'pnpm-lock.yaml has no package or snapshot entry for %s',
    (name) => {
      const names = [...lockedPackages(), ...lockedSnapshots()].map(
        (entry) => entry.name,
      );

      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain(name);
    },
  );

  it('no locked version carries a @nestjs/platform-express peer suffix', () => {
    expect(readLockfile()).not.toContain('(@nestjs/platform-express@');
  });

  it('src, test and the README never mention it', () => {
    const thisFile = relative(appRoot, import.meta.filename);
    const paths = [
      ...listAppFiles('src'),
      ...listAppFiles('test').filter((path) => path !== thisFile),
      'README.md',
    ];
    const offenders = paths.filter((path) =>
      /OBSERVE_|@nestjs\/observe/.test(readAppFile(path)),
    );

    expect(offenders).toEqual([]);
  });
});

describe('the HTTP adapter cannot be loaded', () => {
  // Resolve the way @nestjs/core itself would, from its installed location, so
  // a future NestFactory.create fails loudly instead of finding an adapter.
  const fromCore = createRequire(
    createRequire(import.meta.url).resolve('@nestjs/core'),
  );

  it('resolves tslib, a real dependency of @nestjs/core (control)', () => {
    expect(fromCore.resolve('tslib')).toMatch(/[/\\]tslib[/\\]/);
  });

  it.each(['@nestjs/platform-express', 'express'])(
    'resolving %s from @nestjs/core throws MODULE_NOT_FOUND',
    (name) => {
      expect(() => fromCore.resolve(name)).toThrow(
        expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
      );
    },
  );
});
