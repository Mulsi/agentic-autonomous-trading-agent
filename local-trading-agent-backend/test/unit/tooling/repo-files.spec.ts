import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { parseSettings, settingsSchema } from '../../../src/config/settings.js';
import { FIXTURE_API_KEY } from '../../fixtures/env.js';
import {
  isSpecFile,
  listAppFiles,
  readRepoFile,
  repoRoot,
} from '../../fixtures/repo.js';

describe('.env.example', () => {
  const example = parseEnv(readRepoFile('.env.example'));

  it('has exactly the settings schema keys', () => {
    const keys = Object.keys(example).sort();

    expect(keys).toEqual(['ANTHROPIC_API_KEY', 'DATABASE_URL', 'TRADER_MODE']);
    expect(keys).toEqual(Object.keys(settingsSchema.shape).sort());
  });

  it('sets the paper mode and leaves the key empty', () => {
    expect(example.TRADER_MODE).toBe('paper');
    expect(example.ANTHROPIC_API_KEY).toBe('');
  });

  it('passes parseSettings once a fixture key is filled in', () => {
    const filled = { ...example, ANTHROPIC_API_KEY: FIXTURE_API_KEY };

    expect(parseSettings(filled).TRADER_MODE).toBe('paper');
  });
});

describe('progress.md', () => {
  const progress = readRepoFile('progress.md');
  const next = progress.split(/^## Next$/m)[1]?.split(/^## /m)[0] ?? '';

  it('marks S0a done', () => {
    expect(progress).toMatch(/^- \[x\] S0a /m);
  });

  it('names S0b as next', () => {
    expect(next).toContain('S0b');
    expect(progress).not.toMatch(/^- \[x\] S0b /m);
  });

  it('records the D1 settlement', () => {
    expect(progress).toContain('D1');
    expect(progress).toContain('`local-trading-agent-backend/`');
    expect(progress).toContain('`prompts/`');
    expect(progress).toContain('`scripts/`');
  });

  it('records the linter settlement', () => {
    expect(progress).toContain('typescript-eslint');
    expect(progress).toContain('oxlint');
  });
});

describe('tests.json', () => {
  const registry = z
    .strictObject({
      tests: z.array(
        z.strictObject({
          file: z.string().min(1),
          milestone: z.string().min(1),
          covers: z.string().min(1),
          status: z.enum(['passing', 'failing']),
        }),
      ),
    })
    .parse(JSON.parse(readRepoFile('tests.json')));
  const listed = registry.tests.map((entry) => entry.file);

  it('lists only files that exist', () => {
    const missing = listed.filter((file) => !existsSync(join(repoRoot, file)));

    expect(missing).toEqual([]);
  });

  it('lists every spec file exactly once', () => {
    const specs = [...listAppFiles('src'), ...listAppFiles('test')]
      .filter(isSpecFile)
      .map((path) => `local-trading-agent-backend/${path}`);

    expect([...listed].sort()).toEqual(specs.sort());
  });
});
