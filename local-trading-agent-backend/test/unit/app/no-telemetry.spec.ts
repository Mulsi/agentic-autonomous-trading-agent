import { relative } from 'node:path';
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

describe('telemetry and HTTP packages', () => {
  it.each(REMOVED_PACKAGES)('package.json has no %s', (name) => {
    const { dependencies, devDependencies } = readPackageJson();

    expect({ ...dependencies, ...devDependencies }).not.toHaveProperty(name);
  });

  it('pnpm-lock.yaml has no @nestjs/observe', () => {
    expect(readAppFile('pnpm-lock.yaml')).not.toContain('@nestjs/observe');
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
