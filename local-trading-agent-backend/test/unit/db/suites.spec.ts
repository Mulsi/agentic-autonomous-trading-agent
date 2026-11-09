import { matchesGlob } from 'node:path';
import type { ViteUserConfig } from 'vitest/config';
import dbConfig from '../../../vitest.config.db.js';
import e2eConfig from '../../../vitest.config.e2e.js';
import unitConfig from '../../../vitest.config.js';
import { isSpecFile, listAppFiles } from '../../fixtures/repo.js';

const files = [...listAppFiles('src'), ...listAppFiles('test')];
const dbSpecs = files.filter((path) => path.endsWith('.db-spec.ts'));

function collected(config: ViteUserConfig): string[] {
  const include = config.test?.include ?? [];
  const exclude = config.test?.exclude ?? [];
  return files.filter(
    (path) =>
      include.some((glob) => matchesGlob(path, glob)) &&
      !exclude.some((glob) => matchesGlob(path, glob)),
  );
}

describe('DB test suite', () => {
  it('has DB specs, all under test/', () => {
    expect(dbSpecs.length).toBeGreaterThan(0);
    for (const path of dbSpecs) {
      expect(path.startsWith('test/')).toBe(true);
    }
  });

  it('counts *.db-spec.ts as a spec file', () => {
    expect(isSpecFile('test/db/example.db-spec.ts')).toBe(true);
  });

  it('pnpm test collects no DB spec', () => {
    const unit = collected(unitConfig);

    expect(unit.length).toBeGreaterThan(0);
    expect(unit.filter((path) => path.endsWith('.db-spec.ts'))).toEqual([]);
  });

  it('pnpm test:e2e collects no DB spec', () => {
    expect(
      collected(e2eConfig).filter((path) => path.endsWith('.db-spec.ts')),
    ).toEqual([]);
  });

  it('pnpm test:db collects exactly the DB specs', () => {
    expect(collected(dbConfig).sort()).toEqual([...dbSpecs].sort());
  });
});
