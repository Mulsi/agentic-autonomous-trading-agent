import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { parseSettings, settingsSchema } from '../../../src/config/settings.js';
import {
  isSpecFile,
  listAppFiles,
  nonSpecSources,
  readRepoFile,
  repoRoot,
} from '../../fixtures/repo.js';

/** The text of a `## ` section, up to the next one. */
function section(markdown: string, heading: string): string {
  const start = markdown.split(new RegExp(`^## ${heading}$`, 'm'))[1];
  return start?.split(/^## /m)[0] ?? '';
}

/** The text of a `### ` subsection, up to the next heading of any level. */
function subsection(markdown: string, heading: string): string {
  const start = markdown.split(new RegExp(`^### ${heading}$`, 'm'))[1];
  return start?.split(/^#{2,3} /m)[0] ?? '';
}

describe('.env.example', () => {
  const text = readRepoFile('.env.example');
  const example = parseEnv(text);

  it('has exactly the settings schema keys: DATABASE_URL, TRADER_MODE and DATABASE_IDENTITY', () => {
    const keys = Object.keys(example).sort();

    expect(keys).toEqual(['DATABASE_IDENTITY', 'DATABASE_URL', 'TRADER_MODE']);
    expect(keys).toEqual(Object.keys(settingsSchema.shape).sort());
  });

  it('sets the paper mode', () => {
    expect(example.TRADER_MODE).toBe('paper');
  });

  it('leaves DATABASE_IDENTITY blank', () => {
    expect(example.DATABASE_IDENTITY).toBe('');
    expect(text.split('\n')).toContain('DATABASE_IDENTITY=');
  });

  it('passes parseSettings as it is, with nothing filled in', () => {
    expect(parseSettings(example)).toEqual({
      DATABASE_URL: example.DATABASE_URL,
      TRADER_MODE: 'paper',
    });
    expect(parseSettings(example).DATABASE_IDENTITY).toBeUndefined();
  });

  it('keeps the compose database URL', () => {
    expect(example.DATABASE_URL).toBe(
      'postgresql://trader:local-dev-only@127.0.0.1:55432/trader',
    );
  });

  it('keeps the DATABASE_URL and TRADER_MODE lines unchanged', () => {
    expect(text.split('\n').slice(0, 2)).toEqual([
      'DATABASE_URL=postgresql://trader:local-dev-only@127.0.0.1:55432/trader',
      'TRADER_MODE=paper',
    ]);
  });
});

describe('ANTHROPIC_API_KEY is gone (D9)', () => {
  it.each(['docker-compose.yml', '.env.example'])(
    '%s does not name it',
    (path) => {
      expect(readRepoFile(path)).not.toContain('ANTHROPIC_API_KEY');
    },
  );

  it('the Current state section of progress.md does not name it', () => {
    const current = section(readRepoFile('progress.md'), 'Current state');

    expect(current).not.toBe('');
    expect(current).not.toContain('ANTHROPIC_API_KEY');
  });

  it('only src/config/logging.ts names it, as a redact key path', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('ANTHROPIC_API_KEY'))
      .map(({ path }) => path);

    expect(files).toEqual(['src/config/logging.ts']);
  });
});

describe('progress.md', () => {
  const progress = readRepoFile('progress.md');
  const next = section(progress, 'Next');

  it('marks S0a, S0b, S0c and S0d done', () => {
    expect(progress).toMatch(/^- \[x\] S0a /m);
    expect(progress).toMatch(/^- \[x\] S0b /m);
    expect(progress).toMatch(/^- \[x\] S0c /m);
    expect(progress).toMatch(/^- \[x\] S0d /m);
  });

  it('marks S0e done', () => {
    expect(progress).toMatch(/^- \[x\] S0e /m);
  });

  it('says S0 is complete and names S1a as next', () => {
    expect(next).toMatch(/^- S1a /m);
    expect(next).toContain('S0 is complete');
    expect(next).not.toMatch(/^- S0/m);
  });

  it('mentions the digest pin in its Database section', () => {
    const database = subsection(section(progress, 'Current state'), 'Database');

    expect(database).toMatch(/pinned by digest/);
    expect(database).toContain('`make db-up`');
    expect(database).toContain('`pnpm test:db`');
  });

  it('has a Dependencies settlement', () => {
    const settlement = subsection(
      section(progress, 'Settlements'),
      'Dependencies',
    );

    expect(settlement).not.toBe('');
    for (const needle of [
      '@nestjs/platform-express',
      '@nestjs/mau',
      '`deploy`',
      'typescript',
      'GHSA-67mh-4wv8-2f99',
    ]) {
      expect(settlement).toContain(needle);
    }
  });

  it('names @isaacs/nonrecursive-glob-match as a transitive dev package from @nestjs/cli', () => {
    const settlement = subsection(
      section(progress, 'Settlements'),
      'Dependencies',
    );
    const line = settlement
      .split('\n')
      .find((text) => text.includes('`@isaacs/nonrecursive-glob-match`'));

    expect(line).toBeDefined();
    expect(line).toMatch(/transitive/);
    expect(line).toMatch(/dev/);
    expect(line).toContain('`@nestjs/cli`');
  });

  it('mentions the value-based scrub in Current state', () => {
    const current = section(progress, 'Current state');

    expect(current).toMatch(/scrubbed by value/);
  });

  it('records that .env.example has three keys', () => {
    expect(progress).toContain('`.env.example` has three keys');
    expect(progress).not.toContain('`.env.example` has two keys');
  });

  describe('Current state describes S0e', () => {
    const current = section(progress, 'Current state');

    it.each([
      ['the connection at boot', '`src/db/client.ts`'],
      ['the identity setting', '`DATABASE_IDENTITY`'],
      ['not_configured', '`not_configured`'],
      ['missing_marker', '`missing_marker`'],
      ['mismatch', '`mismatch`'],
      ['unreadable', '`unreadable`'],
      ['the setup with docker compose ps', '`docker compose ps`'],
      ['the research role', '`research_reader`'],
      ['the _ms rule', '`_ms`'],
      ['timestamptz', '`timestamptz`'],
      ['the scrubbed failed-boot output', '`scrubSecrets`'],
    ])('names %s', (_, needle) => {
      expect(current).toContain(needle);
    });

    it('gives the identity setup steps in order', () => {
      const setup = current.slice(current.indexOf('Setup'));
      const steps = [
        '`make db-up`',
        'identity line',
        '`docker compose ps`',
        '`DATABASE_IDENTITY` in `.env`',
      ].map((needle) => setup.indexOf(needle));

      expect(steps.every((at) => at >= 0)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    });
  });

  it('records the hand-offs to S7a, S7b, S11a and S12', () => {
    const handOff = subsection(
      section(progress, 'Settlements'),
      'Hand-offs from S0e',
    );

    for (const needle of [
      'S7a',
      'S7b',
      'S11a',
      'S12',
      'kill_on_database_integrity_failure',
    ]) {
      expect(handOff).toContain(needle);
    }
  });

  it.each([
    '`make db-up`',
    '`pnpm db:migrate`',
    '`pnpm test:db`',
    '`research/`',
  ])('describes %s', (needle) => {
    expect(progress).toContain(needle);
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
