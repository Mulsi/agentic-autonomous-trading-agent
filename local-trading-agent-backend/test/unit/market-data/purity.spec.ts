import { dirname, join, normalize } from 'node:path';
import { listAppFiles, readAppFile } from '../../fixtures/repo.js';

// A text scan of the shared market-data code (D13). The needles below are
// built from parts, so this file does not match its own scan for endpoints.

const PURE_FILES = [
  'src/market-data/normalizer.ts',
  'src/market-data/validator.ts',
  'src/shared/decimal.ts',
];

/** Every module specifier in `import ... from`, `export ... from`, `import()` and `require()`. */
function specifiers(text: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1] as string),
  );
}

function isAllowed(file: string, specifier: string): boolean {
  if (specifier === 'decimal.js' || specifier === 'zod') return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const target = normalize(join(dirname(file), specifier));
  return (
    target.startsWith('src/shared/') || target.startsWith('src/market-data/')
  );
}

describe('the scan helpers', () => {
  it('finds every import form', () => {
    expect(
      specifiers(
        [
          "import { a } from 'zod';",
          "import type { B } from '../db/client.js';",
          "export * from 'pg';",
          "import 'node:fs';",
          "await import('ws');",
          "require('undici');",
        ].join('\n'),
      ).sort(),
    ).toEqual(['../db/client.js', 'node:fs', 'pg', 'undici', 'ws', 'zod']);
  });

  it.each([
    ['decimal.js', true],
    ['zod', true],
    ['../shared/decimal.js', true],
    ['./normalizer.js', true],
    ['../db/client.js', false],
    ['../config/settings.js', false],
    ['@nestjs/common', false],
    ['drizzle-orm', false],
    ['pg', false],
    ['nestjs-pino', false],
    ['pino', false],
    ['node:fs', false],
    ['node:http', false],
    ['node:https', false],
    ['node:net', false],
    ['ws', false],
    ['undici', false],
  ])('from src/market-data/validator.ts, %s allowed is %s', (spec, allowed) => {
    expect(isAllowed('src/market-data/validator.ts', spec)).toBe(allowed);
  });
});

describe.each(PURE_FILES)('%s (criteria 24 and 25)', (file) => {
  const text = readAppFile(file);

  it('imports only decimal.js, zod and src/shared or src/market-data modules', () => {
    const found = specifiers(text);

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((specifier) => !isAllowed(file, specifier))).toEqual(
      [],
    );
  });

  it.each([
    '@nestjs/',
    'drizzle-orm',
    "'pg'",
    'nestjs-pino',
    "'pino'",
    '/db/',
    '/config/',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    "'ws'",
    'undici',
  ])('never names %s', (needle) => {
    expect(text).not.toContain(needle);
  });

  it.each([
    ['Date', '.now'],
    ['new ', 'Date'],
    ['Math', '.random'],
    ['process', '.env'],
    ['fetch', '('],
    ['console', '.'],
  ])('has no hidden input %s%s', (a, b) => {
    expect(text).not.toContain(a + b);
  });
});

describe('no live endpoints (criterion 26)', () => {
  const needles = [
    ['http', '://'],
    ['https', '://'],
    ['wss', '://'],
    ['binance', '.com'],
    ['binance', '.vision'],
  ].map((parts) => parts.join(''));
  const files = [
    ...listAppFiles('src/market-data'),
    ...listAppFiles('test/unit/market-data'),
    ...listAppFiles('test/fixtures/market-data'),
  ];

  it('scans the market-data source, tests and fixtures', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/market-data/normalizer.ts',
        'src/market-data/validator.ts',
        'test/unit/market-data/purity.spec.ts',
        'test/fixtures/market-data/btcusdt-15m-2026-10-01.csv',
      ]),
    );
  });

  it.each(needles)('no file contains %s', (needle) => {
    const offenders = files.filter((path) =>
      readAppFile(path).toLowerCase().includes(needle),
    );

    expect(offenders).toEqual([]);
  });
});
