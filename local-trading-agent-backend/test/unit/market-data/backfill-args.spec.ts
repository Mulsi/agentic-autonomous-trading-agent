import { run, type BackfillDeps } from '../../../src/backfill.js';
import { parseBackfillArgs } from '../../../src/market-data/backfill-args.js';
import { readAppFile } from '../../fixtures/repo.js';

// S1b criterion 12.

const FULL: Record<string, string> = {
  '--symbol': 'BTCUSDT',
  '--interval': '15m',
  '--period': 'daily',
  '--from': '2026-10-01',
  '--to': '2026-10-01',
  '--outlier-window': '4',
  '--outlier-multiple': '5',
};

function argv(
  overrides: Record<string, string | null> = {},
  extra: string[] = [],
): string[] {
  const flags = { ...FULL, ...overrides };
  return [
    ...Object.entries(flags).flatMap(([flag, value]) =>
      value === null ? [] : [flag, value],
    ),
    ...extra,
  ];
}

/** Deps whose every part records a call; none may be used on a usage error. */
function spyDeps() {
  const stderr: string[] = [];
  const deps = {
    clock: vi.fn(() => Date.UTC(2026, 10, 1)),
    dryRunHttp: vi.fn(() => {
      throw new Error('HttpGet constructed');
    }),
    openContext: vi.fn(() => Promise.reject(new Error('context opened'))),
    bootFailed: vi.fn(),
    stdout: vi.fn(),
    stderr: vi.fn((text: string) => {
      stderr.push(text);
    }),
  } satisfies BackfillDeps;
  return { deps, stderr };
}

async function expectUsageError(args: string[], flag: string): Promise<void> {
  const parsed = parseBackfillArgs(args);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).toContain(flag);

  const { deps, stderr } = spyDeps();
  expect(await run(args, deps)).toBe(2);
  expect(stderr.join('')).toContain(flag);
  expect(stderr.join('')).toContain('usage: backfill');
  expect(deps.dryRunHttp).not.toHaveBeenCalled();
  expect(deps.openContext).not.toHaveBeenCalled();
  expect(deps.stdout).not.toHaveBeenCalled();
}

describe('parseBackfillArgs (criterion 12)', () => {
  it('parses the full flag set', () => {
    expect(parseBackfillArgs(argv({}, ['--dry-run']))).toEqual({
      ok: true,
      args: {
        symbol: 'BTCUSDT',
        interval: '15m',
        period: 'daily',
        from: '2026-10-01',
        to: '2026-10-01',
        outlierWindow: 4,
        outlierMultiple: 5,
        dryRun: true,
      },
    });
    const parsed = parseBackfillArgs(argv());
    expect(parsed.ok && parsed.args.dryRun).toBe(false);
  });

  it('parses flags in any order', () => {
    const args = argv();
    const pairs: string[][] = [];
    for (let at = 0; at < args.length; at += 2)
      pairs.push(args.slice(at, at + 2));

    expect(parseBackfillArgs(pairs.reverse().flat()).ok).toBe(true);
  });

  it.each(Object.keys(FULL))('exits 2 when %s is left out', async (flag) => {
    await expectUsageError(argv({ [flag]: null }), flag);
  });

  it('exits 2 on an unknown flag', async () => {
    await expectUsageError(argv({}, ['--force', 'yes']), '--force');
    await expectUsageError(argv({}, ['--symbol=BTCUSDT']), '--symbol=BTCUSDT');
  });

  it('exits 2 on a repeated flag', async () => {
    await expectUsageError(argv({}, ['--symbol', 'ETHUSDT']), '--symbol');
    await expectUsageError(argv({}, ['--dry-run', '--dry-run']), '--dry-run');
  });

  it('exits 2 on a flag with no value', async () => {
    await expectUsageError([...argv({ '--to': null }), '--to'], '--to');
    await expectUsageError(
      ['--symbol', '--interval', ...argv({ '--symbol': null })],
      '--symbol',
    );
  });

  it.each(['0', '1.5', '-1', '', '01', 'x', '1e3'])(
    'exits 2 on --outlier-window %j',
    async (value) => {
      await expectUsageError(
        argv({ '--outlier-window': value }),
        '--outlier-window',
      );
    },
  );

  it.each([
    '0.99',
    '0',
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '0.99999999999999999999',
    '',
    '1.',
    '.5',
    ' 2',
  ])('exits 2 on --outlier-multiple %j', async (value) => {
    await expectUsageError(
      argv({ '--outlier-multiple': value }),
      '--outlier-multiple',
    );
  });

  it.each([
    ['1', 1],
    ['1000', 1000],
    ['2.5', 2.5],
    ['1.0', 1],
  ])('accepts --outlier-multiple %s', (value, expected) => {
    const parsed = parseBackfillArgs(argv({ '--outlier-multiple': value }));

    expect(parsed.ok && parsed.args.outlierMultiple).toBe(expected);
  });

  it.each([
    ['--symbol', 'btcusdt'],
    ['--symbol', '../BTCUSDT'],
    ['--interval', '5m'],
    ['--period', 'weekly'],
    ['--from', '2026-10'],
    ['--to', '2026-02-30'],
  ])('exits 2 on %s %j', async (flag, value) => {
    await expectUsageError(argv({ [flag]: value }), flag);
  });

  it('exits 2 when --from is after --to', async () => {
    await expectUsageError(
      argv({ '--from': '2026-10-02', '--to': '2026-10-01' }),
      '--from',
    );
  });

  it('exits 2, before any request, when --to names a period that has not closed', async () => {
    const { deps, stderr } = spyDeps();
    deps.clock.mockReturnValue(Date.UTC(2026, 9, 2) - 1);

    expect(await run(argv({}, ['--dry-run']), deps)).toBe(2);
    expect(stderr.join('')).toContain('to names a period that has not closed');
    expect(deps.dryRunHttp).not.toHaveBeenCalled();
    expect(deps.openContext).not.toHaveBeenCalled();
  });
});

describe('no default for either outlier flag (criterion 12)', () => {
  const text = readAppFile('src/market-data/backfill-args.ts');

  it.each(['.default(', '.prefault(', '.catch(', '??', '.optional('])(
    'backfill-args.ts has no %s',
    (needle) => {
      expect(text).not.toContain(needle);
    },
  );

  it('declares both outlier flags as required strings', () => {
    expect(text).toMatch(/'--outlier-window': z\s*\n?\s*\.string\(\)/);
    expect(text).toMatch(/'--outlier-multiple': z\s*\n?\s*\.string\(\)/);
  });
});
