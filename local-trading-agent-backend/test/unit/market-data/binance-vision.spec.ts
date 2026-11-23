import fc from 'fast-check';
import {
  BINANCE_VISION_ORIGIN,
  bulkFile,
  filesFor,
  parseChecksum,
} from '../../../src/market-data/binance-vision.js';
import { MAX_CHECKSUM_BYTES } from '../../../src/market-data/bulk-limits.js';

// S1b criteria 1 to 4. URLs are built from the imported origin constant, so no
// host name is written in this file.

const HASH = 'a'.repeat(40) + '0123456789abcdef01234567';
const ZIP = 'BTCUSDT-15m-2026-10-01.zip';

describe('bulkFile and filesFor (criterion 1)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  describe.each(['UTC', 'Europe/Ljubljana', 'Pacific/Chatham'])(
    'under TZ=%s',
    (tz) => {
      beforeEach(() => {
        process.env.TZ = tz;
      });

      it('names and ranges the BTCUSDT 15m daily file for 2026-10-01', () => {
        const file = bulkFile('BTCUSDT', '15m', 'daily', '2026-10-01');

        expect(file.zipName).toBe('BTCUSDT-15m-2026-10-01.zip');
        expect(file.csvName).toBe('BTCUSDT-15m-2026-10-01.csv');
        expect(file.checksumName).toBe('BTCUSDT-15m-2026-10-01.zip.CHECKSUM');
        expect(file.zipUrl).toBe(
          `${BINANCE_VISION_ORIGIN}/data/spot/daily/klines/BTCUSDT/15m/BTCUSDT-15m-2026-10-01.zip`,
        );
        expect(file.checksumUrl).toBe(`${file.zipUrl}.CHECKSUM`);
        expect(file.range).toEqual({
          fromMs: 1790812800000,
          toMs: 1790899200000,
        });
      });

      it('ranges the monthly 2026-09 file over the calendar month', () => {
        const file = bulkFile('BTCUSDT', '1h', 'monthly', '2026-09');

        expect(file.zipName).toBe('BTCUSDT-1h-2026-09.zip');
        expect(file.zipUrl).toBe(
          `${BINANCE_VISION_ORIGIN}/data/spot/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2026-09.zip`,
        );
        expect(file.range).toEqual({
          fromMs: Date.UTC(2026, 8, 1),
          toMs: Date.UTC(2026, 9, 1),
        });
      });

      it('lists 2026-09-30 to 2026-10-02 daily as three ascending files', () => {
        const files = filesFor(
          'BTCUSDT',
          '15m',
          'daily',
          '2026-09-30',
          '2026-10-02',
        );

        expect(files.map((file) => file.date)).toEqual([
          '2026-09-30',
          '2026-10-01',
          '2026-10-02',
        ]);
        expect(files.map((file) => file.range.fromMs)).toEqual([
          Date.UTC(2026, 8, 30),
          Date.UTC(2026, 9, 1),
          Date.UTC(2026, 9, 2),
        ]);
      });

      it('lists monthly files across a year end, and a leap February', () => {
        expect(
          filesFor('BTCUSDT', '1d', 'monthly', '2027-11', '2028-02').map(
            (file) => file.date,
          ),
        ).toEqual(['2027-11', '2027-12', '2028-01', '2028-02']);
        expect(bulkFile('BTCUSDT', '1d', 'daily', '2028-02-29').range).toEqual({
          fromMs: Date.UTC(2028, 1, 29),
          toMs: Date.UTC(2028, 2, 1),
        });
      });
    },
  );

  it('lists one file when from equals to', () => {
    expect(
      filesFor('ETHUSDT', '4h', 'daily', '2026-10-01', '2026-10-01'),
    ).toHaveLength(1);
  });
});

describe('invalid arguments throw, naming the argument (criterion 2)', () => {
  const expectThrow = (fn: () => unknown, name: string): void => {
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown instanceof TypeError || thrown instanceof RangeError).toBe(
      true,
    );
    expect((thrown as Error).message).toMatch(new RegExp(`^${name} `));
  };

  it.each([
    'btcusdt',
    'BTC/USDT',
    '../BTCUSDT',
    'BTCUSDT%2F',
    'BTCEUR',
    `${'A'.repeat(21)}USDT`,
    'USDT',
    '',
  ])('symbol %j', (symbol) => {
    expectThrow(() => bulkFile(symbol, '15m', 'daily', '2026-10-01'), 'symbol');
    expectThrow(
      () => filesFor(symbol, '15m', 'daily', '2026-10-01', '2026-10-01'),
      'symbol',
    );
  });

  it('accepts 20 characters before USDT', () => {
    expect(
      bulkFile(`${'A'.repeat(20)}USDT`, '15m', 'daily', '2026-10-01').symbol,
    ).toHaveLength(24);
  });

  it.each(['5m', '1M', '', '15M'])('interval %j', (interval) => {
    expectThrow(
      () => bulkFile('BTCUSDT', interval, 'daily', '2026-10-01'),
      'interval',
    );
  });

  it.each(['weekly', 'Daily', ''])('period %j', (period) => {
    expectThrow(() => bulkFile('BTCUSDT', '15m', period, '2026-10'), 'period');
  });

  it.each([
    '2026-13-01',
    '2026-02-30',
    '2026-10-1',
    '2026-10-01T00:00',
    '2026-00-10',
    '2026-10-00',
    '2026-10-32',
    '2027-02-29',
    ' 2026-10-01',
    '2026-10-01\n',
  ])('daily date %j', (date) => {
    expectThrow(() => bulkFile('BTCUSDT', '15m', 'daily', date), 'date');
  });

  it('a monthly date in daily form, and the reverse', () => {
    expectThrow(
      () => bulkFile('BTCUSDT', '15m', 'monthly', '2026-10-01'),
      'date',
    );
    expectThrow(() => bulkFile('BTCUSDT', '15m', 'daily', '2026-10'), 'date');
    expectThrow(
      () => filesFor('BTCUSDT', '15m', 'daily', '2026-10', '2026-10-02'),
      'from',
    );
    expectThrow(
      () => filesFor('BTCUSDT', '15m', 'monthly', '2026-10', '2026-11-01'),
      'to',
    );
  });

  it('a non-string argument', () => {
    expectThrow(() => bulkFile(42, '15m', 'daily', '2026-10-01'), 'symbol');
    expectThrow(() => bulkFile('BTCUSDT', '15m', 'daily', 20261001), 'date');
  });

  it('from after to', () => {
    expectThrow(
      () => filesFor('BTCUSDT', '15m', 'daily', '2026-10-02', '2026-10-01'),
      'from',
    );
    expectThrow(
      () => filesFor('BTCUSDT', '15m', 'monthly', '2026-11', '2026-10'),
      'from',
    );
  });
});

describe('parseChecksum (criterion 3)', () => {
  it.each([
    ['two spaces and a newline', `${HASH}  ${ZIP}\n`],
    ['two spaces', `${HASH}  ${ZIP}`],
    ['one space and a newline', `${HASH} ${ZIP}\n`],
  ])('accepts %s', (_, text) => {
    expect(parseChecksum(text, ZIP)).toEqual({ ok: true, sha256: HASH });
  });

  it.each([
    ['upper-case hex', `${HASH.toUpperCase()}  ${ZIP}\n`],
    ['63 hex digits', `${HASH.slice(1)}  ${ZIP}\n`],
    ['65 hex digits', `${HASH}0  ${ZIP}\n`],
    ['another file name', `${HASH}  BTCUSDT-15m-2026-10-02.zip\n`],
    ['a parent path', `${HASH}  ../${ZIP}\n`],
    ['a directory path', `${HASH}  dir/${ZIP}\n`],
    ['two lines', `${HASH}  ${ZIP}\n${HASH}  ${ZIP}\n`],
    ['an empty body', ''],
    ['only a newline', '\n'],
    ['three spaces', `${HASH}   ${ZIP}\n`],
    ['a tab', `${HASH}\t${ZIP}\n`],
    ['a carriage return', `${HASH}  ${ZIP}\r\n`],
    ['a binary-mode star', `${HASH} *${ZIP}\n`],
    ['two trailing newlines', `${HASH}  ${ZIP}\n\n`],
    [
      'a body of MAX_CHECKSUM_BYTES + 1 bytes',
      `${HASH}  ${ZIP}`.padEnd(MAX_CHECKSUM_BYTES + 1, ' '),
    ],
  ])('rejects %s', (_, text) => {
    expect(parseChecksum(text, ZIP).ok).toBe(false);
  });

  it('names why a too-large body fails before reading it', () => {
    expect(parseChecksum('x'.repeat(MAX_CHECKSUM_BYTES + 1), ZIP)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('zipUrl property (criterion 4)', () => {
  const symbol = fc
    .tuple(fc.stringMatching(/^[A-Z0-9]{1,20}$/), fc.constant('USDT'))
    .map(([base, quote]) => base + quote);
  const interval = fc.constantFrom('15m', '1h', '4h', '1d');
  const period = fc.constantFrom('daily', 'monthly');
  const date = fc
    .record({
      year: fc.integer({ min: 2017, max: 2099 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map(({ year, month, day }) => ({
      daily: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      monthly: `${year}-${String(month).padStart(2, '0')}`,
    }));

  it('starts with the spot path and has exactly the expected segments', () => {
    fc.assert(
      fc.property(symbol, interval, period, date, (s, i, p, d) => {
        const file = bulkFile(s, i, p, d[p]);
        const prefix = `${BINANCE_VISION_ORIGIN}/data/spot/`;

        expect(file.zipUrl.startsWith(prefix)).toBe(true);
        const segments = file.zipUrl
          .slice(BINANCE_VISION_ORIGIN.length + 1)
          .split('/');
        expect(segments).toEqual([
          'data',
          'spot',
          p,
          'klines',
          s,
          i,
          `${s}-${i}-${d[p]}.zip`,
        ]);
        for (const segment of segments) {
          expect(segment).not.toBe('');
          expect(segment).not.toContain('..');
          expect(segment).not.toContain('%');
        }
        expect(file.checksumUrl).toBe(`${file.zipUrl}.CHECKSUM`);
      }),
      { numRuns: 500 },
    );
  });
});
