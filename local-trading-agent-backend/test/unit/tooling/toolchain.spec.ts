import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appRoot,
  readAppFile,
  readPackageJson,
  readRepoFile,
} from '../../fixtures/repo.js';

describe('Node version', () => {
  it('pins Node 26 in .nvmrc and engines, and runs on it', () => {
    expect(readRepoFile('.nvmrc').trim()).toBe('26');
    expect(readPackageJson().engines?.node).toBe('>=26.0.0 <27.0.0');
    expect(process.versions.node.split('.')[0]).toBe('26');
  });
});

describe('tsconfig', () => {
  const { compilerOptions } = JSON.parse(readAppFile('tsconfig.json')) as {
    compilerOptions: Record<string, unknown>;
  };

  it('is strict, with unchecked index access on', () => {
    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  it('does not weaken strict mode', () => {
    expect(compilerOptions).not.toHaveProperty('strictPropertyInitialization');
  });

  it('is enforced by typecheck on an unchecked index read', () => {
    const items = ['only'];
    // @ts-expect-error noUncheckedIndexedAccess makes this string | undefined. If the flag is removed, this directive is unused and typecheck fails.
    const first: string = items[0];
    expect(first).toBe('only');
  });
});

describe('linter', () => {
  it('has no oxlint left', () => {
    const { dependencies, devDependencies, scripts } = readPackageJson();
    const declared = { ...dependencies, ...devDependencies };

    expect(existsSync(join(appRoot, '.oxlintrc.json'))).toBe(false);
    expect(declared).not.toHaveProperty('oxlint');
    expect(declared).not.toHaveProperty('oxlint-tsgolint');
    expect(scripts.lint).toContain('eslint');
  });
});

describe('build chain', () => {
  it('runs typecheck before nest build', () => {
    const { scripts } = readPackageJson();

    expect(scripts.typecheck).toContain('tsc --noEmit');
    expect(scripts.build).toMatch(/typecheck.*&&.*nest build/);
  });
});
