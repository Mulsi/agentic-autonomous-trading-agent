import fc from 'fast-check';
import {
  type Candle,
  INTERVAL_MS,
  type KlineInterval,
  normalizeEpoch,
  normalizeKlineRow,
  ROW_REJECT_REASONS,
} from '../../../src/market-data/normalizer.js';
import { Decimal } from '../../../src/shared/decimal.js';
import {
  ANCHOR_MS,
  bulkCsvRows,
  candleView,
  restJsonRows,
} from '../../fixtures/market-data/klines.js';

const INTERVALS = Object.keys(INTERVAL_MS) as KlineInterval[];
const MS_MIN = 1483228800000;
const MS_END = 4102444800000;
const US_MIN = MS_MIN * 1000;
const US_END = MS_END * 1000;
const FIFTEEN = INTERVAL_MS['15m'];

const MONEY_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'quoteVolume',
  'takerBuyBaseVolume',
  'takerBuyQuoteVolume',
] as const;

/** A valid 15m ms row at the anchor; fields can be replaced by index. */
function row(overrides: Readonly<Record<number, unknown>> = {}): unknown[] {
  const fields: unknown[] = [
    ANCHOR_MS,
    '60000.00000000',
    '60100.00000000',
    '59900.00000000',
    '60050.00000000',
    '10.00000000',
    ANCHOR_MS + FIFTEEN - 1,
    '600500.00000000',
    120,
    '4.00000000',
    '240200.00000000',
    '0',
  ];
  for (const [index, value] of Object.entries(overrides)) {
    fields[Number(index)] = value;
  }
  return fields;
}

/** The same row with both times in µs. */
function toMicros(fields: readonly unknown[]): unknown[] {
  const copy = [...fields];
  copy[0] = (fields[0] as number) * 1000;
  copy[6] = (fields[6] as number) * 1000 + 999;
  return copy;
}

function accepted(fields: unknown, interval: KlineInterval = '15m'): Candle {
  const result = normalizeKlineRow(fields, 'BTCUSDT', interval);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result.candle;
}

function reasonOf(fields: unknown, interval: KlineInterval = '15m'): string {
  const result = normalizeKlineRow(fields, 'BTCUSDT', interval);
  return result.ok ? 'accepted' : result.reason;
}

describe('normalizeEpoch, D12 (criterion 3)', () => {
  it.each([1790812800000, '1790812800000'])('reads %j as ms', (raw) => {
    expect(normalizeEpoch(raw)).toEqual({
      ok: true,
      ms: 1790812800000,
      unit: 'ms',
      value: 1790812800000,
    });
  });

  it.each([1790812800000000, '1790812800000000'])('reads %j as µs', (raw) => {
    expect(normalizeEpoch(raw)).toEqual({
      ok: true,
      ms: 1790812800000,
      unit: 'us',
      value: 1790812800000000,
    });
  });

  it('the anchor is 2026-10-01T00:00:00Z', () => {
    expect(ANCHOR_MS).toBe(Date.UTC(2026, 9, 1));
  });
});

describe('normalizeEpoch properties (criterion 4)', () => {
  const msValue = fc.integer({ min: MS_MIN, max: MS_END - 1 });

  it('every integer in the ms range reads as itself, unit ms', () => {
    fc.assert(
      fc.property(msValue, (m) => {
        expect(normalizeEpoch(m)).toMatchObject({
          ok: true,
          ms: m,
          unit: 'ms',
        });
        expect(normalizeEpoch(String(m))).toMatchObject({
          ok: true,
          ms: m,
          unit: 'ms',
        });
      }),
      { numRuns: 1000 },
    );
  });

  it('m * 1000 + r reads as m, unit us, for every r in [0, 999]', () => {
    fc.assert(
      fc.property(msValue, fc.integer({ min: 0, max: 999 }), (m, r) => {
        const value = m * 1000 + r;

        expect(normalizeEpoch(value)).toEqual({
          ok: true,
          ms: m,
          unit: 'us',
          value,
        });
        expect(normalizeEpoch(String(value))).toMatchObject({ ms: m });
      }),
      { numRuns: 1000 },
    );
  });

  it('no value is accepted as both units: the unit follows the range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (v) => {
        const inMs = v >= MS_MIN && v < MS_END;
        const inUs = v >= US_MIN && v < US_END;
        const result = normalizeEpoch(v);

        expect(inMs && inUs).toBe(false);
        expect(result.ok).toBe(inMs || inUs);
        if (result.ok) expect(result.unit).toBe(inMs ? 'ms' : 'us');
      }),
      { numRuns: 1000 },
    );
  });
});

describe('normalizeEpoch rejects (criterion 5)', () => {
  it.each([
    ['the ms range start - 1', MS_MIN - 1],
    ['the ms range end', MS_END],
    ['the µs range start - 1', US_MIN - 1],
    ['the µs range end', US_END],
    ['10^13, between the ranges', 10 ** 13],
    ['10^15 - 1, between the ranges', 10 ** 15 - 1],
    ['a 19-digit nanosecond string', '1790812800000000000'],
    ['a 19-digit nanosecond number', 1790812800000000000],
    ['1790812800000.5', 1790812800000.5],
    ['-1', -1],
    ['0', 0],
    ['"01790812800000"', '01790812800000'],
    ['"1790812800000 "', '1790812800000 '],
    ['"0x1A"', '0x1A'],
    ['Number.MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2],
    ['null', null],
    ['a bigint', 1790812800000n],
  ])('%s', (_, raw) => {
    expect(normalizeEpoch(raw)).toEqual({ ok: false });
  });

  it('pins the range ends', () => {
    expect(MS_MIN).toBe(Date.UTC(2017, 0, 1));
    expect(MS_END).toBe(Date.UTC(2100, 0, 1));
    expect(normalizeEpoch(MS_MIN)).toMatchObject({ ok: true, unit: 'ms' });
    expect(normalizeEpoch(MS_END - 1)).toMatchObject({ ok: true, unit: 'ms' });
    expect(normalizeEpoch(US_MIN)).toMatchObject({ ok: true, unit: 'us' });
    expect(normalizeEpoch(US_END - 1)).toMatchObject({ ok: true, unit: 'us' });
  });
});

describe('the same bar in both units (criterion 6)', () => {
  const csv = bulkCsvRows();
  const rest = restJsonRows();

  it('the fixtures hold the same number of bars, µs in the CSV and ms in the JSON', () => {
    expect(csv).toHaveLength(rest.length);
    expect(csv[0]?.[0]).toBe('1790812800000000');
    expect(csv[0]?.[6]).toBe('1790813699999999');
    expect(rest[0]?.[0]).toBe(1790812800000);
    expect(rest[0]?.[6]).toBe(1790813699999);
  });

  it('the first bar normalizes to equal candles from both', () => {
    const fromCsv = accepted(csv[0]);
    const fromRest = accepted(rest[0]);

    expect(fromCsv.openTimeMs).toBe(1790812800000);
    expect(fromCsv.closeTimeMs).toBe(1790813699999);
    expect(candleView(fromCsv)).toEqual(candleView(fromRest));
    for (const field of MONEY_FIELDS) {
      expect(fromCsv[field].eq(fromRest[field]), field).toBe(true);
    }
  });

  it('every fixture bar agrees between the two forms', () => {
    rest.forEach((restRow, index) => {
      const fromCsv = accepted(csv[index]);
      const fromRest = accepted(restRow);

      expect(candleView(fromCsv)).toEqual(candleView(fromRest));
      expect(fromCsv.openTimeMs).toBe(ANCHOR_MS + index * FIFTEEN);
    });
  });
});

describe('row checks, one reason each (criterion 7)', () => {
  const micros = toMicros(row());

  it.each<[string, unknown, string]>([
    ['11 elements', row().slice(0, 11), 'malformed_row'],
    ['13 elements', [...row(), 'extra'], 'malformed_row'],
    ['not an array', { 0: ANCHOR_MS }, 'malformed_row'],
    ['a string', row().join(','), 'malformed_row'],
    ['an unreadable open time', row({ 0: 'yesterday' }), 'bad_timestamp'],
    ['an unreadable close time', row({ 6: -1 }), 'bad_timestamp'],
    [
      'µs open with ms close',
      [...micros.slice(0, 6), ANCHOR_MS + FIFTEEN - 1, ...micros.slice(7)],
      'timestamp_unit_mismatch',
    ],
    [
      'a 15m open at :07',
      row({ 0: ANCHOR_MS + 7 * 60_000, 6: ANCHOR_MS + 22 * 60_000 - 1 }),
      'misaligned_open_time',
    ],
    [
      'a µs open time ending in 000001',
      [
        ANCHOR_MS * 1000 + 1,
        ...micros.slice(1, 6),
        ANCHOR_MS * 1000 + 1 + FIFTEEN * 1000 - 1,
        ...micros.slice(7),
      ],
      'misaligned_open_time',
    ],
    [
      'close = open + interval',
      row({ 6: ANCHOR_MS + FIFTEEN }),
      'bad_close_time',
    ],
    [
      'close = open + interval - 2',
      row({ 6: ANCHOR_MS + FIFTEEN - 2 }),
      'bad_close_time',
    ],
    ['a price as the JS number 60000.01', row({ 1: 60000.01 }), 'bad_number'],
    ['a trade count of -1', row({ 8: -1 }), 'bad_number'],
    ['a trade count of "1.5"', row({ 8: '1.5' }), 'bad_number'],
    ['a negative volume', row({ 5: '-1' }), 'bad_number'],
    ['low = "0"', row({ 3: '0' }), 'non_positive_price'],
    ['high below close', row({ 2: '60049.99999999' }), 'ohlc_inconsistent'],
    [
      'taker-buy base above volume',
      row({ 9: '10.00000001' }),
      'volume_inconsistent',
    ],
    [
      'taker-buy quote above quote volume',
      row({ 10: '600500.00000001' }),
      'volume_inconsistent',
    ],
  ])('%s gives %s', (_, fields, reason) => {
    expect(reasonOf(fields)).toBe(reason);
  });

  it('covers every reason in the list', () => {
    const reasons = new Set(
      [
        row().slice(0, 11),
        row({ 0: 'x' }),
        [...micros.slice(0, 6), ANCHOR_MS + FIFTEEN - 1, ...micros.slice(7)],
        row({ 0: ANCHOR_MS + 60_000, 6: ANCHOR_MS + 60_000 + FIFTEEN - 1 }),
        row({ 6: ANCHOR_MS + FIFTEEN }),
        row({ 1: 1 }),
        row({ 4: '0' }),
        row({ 2: '1' }),
        row({ 9: '11' }),
      ].map((fields) => reasonOf(fields)),
    );

    expect([...reasons].sort()).toEqual([...ROW_REJECT_REASONS].sort());
  });

  it('accepts the base row in both units', () => {
    expect(reasonOf(row())).toBe('accepted');
    expect(reasonOf(micros)).toBe('accepted');
  });

  it('accepts a trade count given as a string of digits', () => {
    expect(accepted(row({ 8: '120' })).tradeCount).toBe(120);
  });

  it('reads a trade count of -0 as 0, so equal bars stay equal', () => {
    expect(Object.is(accepted(row({ 8: -0 })).tradeCount, 0)).toBe(true);
  });

  it('ignores the twelfth element whatever it holds', () => {
    expect(reasonOf(row({ 11: { anything: [1, 2] } }))).toBe('accepted');
    expect(reasonOf(row({ 11: undefined }))).toBe('accepted');
  });

  it.each<[string, unknown[], string]>([
    [
      'malformed shape over everything else',
      [...row({ 0: 'x', 1: 1, 3: '0' }), 'extra'],
      'malformed_row',
    ],
    ['bad timestamp over a bad number', row({ 6: 'x', 1: 1 }), 'bad_timestamp'],
    [
      'unit mismatch over misalignment',
      [ANCHOR_MS * 1000 + 1, ...row().slice(1)],
      'timestamp_unit_mismatch',
    ],
    [
      'misalignment over a bad close time',
      row({ 0: ANCHOR_MS + 1, 6: ANCHOR_MS }),
      'misaligned_open_time',
    ],
    [
      'bad close time over a bad number',
      row({ 6: ANCHOR_MS, 8: -1 }),
      'bad_close_time',
    ],
    ['bad number over a zero price', row({ 3: '0', 5: 'x' }), 'bad_number'],
    [
      'zero price over inconsistent OHLC',
      row({ 2: '0' }),
      'non_positive_price',
    ],
    [
      'inconsistent OHLC over inconsistent volume',
      row({ 2: '1', 9: '11' }),
      'ohlc_inconsistent',
    ],
  ])('several faults: %s', (_, fields, reason) => {
    expect(reasonOf(fields)).toBe(reason);
  });

  it('sets openTimeMs on a failure whenever the open time was readable', () => {
    expect(normalizeKlineRow(row({ 6: 'x' }), 'BTCUSDT', '15m')).toEqual({
      ok: false,
      reason: 'bad_timestamp',
      openTimeMs: ANCHOR_MS,
    });
    expect(
      normalizeKlineRow(toMicros(row({ 1: 1 })), 'BTCUSDT', '15m'),
    ).toEqual({ ok: false, reason: 'bad_number', openTimeMs: ANCHOR_MS });
    expect(normalizeKlineRow(row({ 0: 'x' }), 'BTCUSDT', '15m')).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    });
    expect(normalizeKlineRow(row().slice(1), 'BTCUSDT', '15m')).toEqual({
      ok: false,
      reason: 'malformed_row',
    });
  });

  it('throws on an unknown interval, naming it', () => {
    expect(() =>
      normalizeKlineRow(row(), 'BTCUSDT', '5m' as KlineInterval),
    ).toThrow(/interval/);
  });
});

/** Fixed-point units of 1e-8 written as a non-negative decimal string. */
function units(n: bigint): string {
  const text = n.toString().padStart(9, '0');
  return `${text.slice(0, -8)}.${text.slice(-8)}`;
}

const barArbitrary = fc.record({
  interval: fc.constantFrom(...INTERVALS),
  unit: fc.constantFrom('ms' as const, 'us' as const),
  slot: fc.integer({ min: 0, max: 2000 }),
  low: fc.bigInt({ min: 2n, max: 10n ** 16n }),
  openAbove: fc.bigInt({ min: 0n, max: 10n ** 14n }),
  closeAbove: fc.bigInt({ min: 0n, max: 10n ** 14n }),
  highAbove: fc.bigInt({ min: 0n, max: 10n ** 14n }),
  volume: fc.bigInt({ min: 0n, max: 10n ** 18n }),
  takerBase: fc.bigInt({ min: 0n, max: 10n ** 18n }),
  quote: fc.bigInt({ min: 0n, max: 10n ** 20n }),
  takerQuote: fc.bigInt({ min: 0n, max: 10n ** 20n }),
  tradeCount: fc.nat(),
});

type Bar = typeof barArbitrary extends fc.Arbitrary<infer T> ? T : never;

interface Prices {
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  takerBase: bigint;
  quote: bigint;
  takerQuote: bigint;
}

function consistentPrices(bar: Bar): Prices {
  const open = bar.low + bar.openAbove;
  const close = bar.low + bar.closeAbove;
  const volume = bar.volume;
  const quote = bar.quote;
  return {
    open,
    close,
    low: bar.low,
    high: (open > close ? open : close) + bar.highAbove,
    volume,
    takerBase: volume === 0n ? 0n : bar.takerBase % (volume + 1n),
    quote,
    takerQuote: quote === 0n ? 0n : bar.takerQuote % (quote + 1n),
  };
}

function barRow(bar: Bar, prices: Prices): unknown[] {
  const step = INTERVAL_MS[bar.interval];
  const openMs = Date.UTC(2026, 0, 1) + bar.slot * step;
  const fields: unknown[] = [
    openMs,
    units(prices.open),
    units(prices.high),
    units(prices.low),
    units(prices.close),
    units(prices.volume),
    openMs + step - 1,
    units(prices.quote),
    bar.tradeCount,
    units(prices.takerBase),
    units(prices.takerQuote),
    '0',
  ];
  return bar.unit === 'us' ? toMicros(fields) : fields;
}

describe('OHLC and volume properties (criterion 8)', () => {
  it('accepts every consistent bar, for every interval and both units', () => {
    fc.assert(
      fc.property(barArbitrary, (bar) => {
        const prices = consistentPrices(bar);
        const candle = accepted(barRow(bar, prices), bar.interval);

        expect(candle.open.toFixed(8)).toBe(units(prices.open));
        expect(candle.high.toFixed(8)).toBe(units(prices.high));
        expect(candle.low.toFixed(8)).toBe(units(prices.low));
        expect(candle.close.toFixed(8)).toBe(units(prices.close));
      }),
      { numRuns: 1000 },
    );
  });

  const mutations: [string, string, (p: Prices) => Prices][] = [
    [
      'high below max(open, close)',
      'ohlc_inconsistent',
      (p) => ({ ...p, high: (p.open > p.close ? p.open : p.close) - 1n }),
    ],
    [
      'low above min(open, close)',
      'ohlc_inconsistent',
      (p) => ({ ...p, low: (p.open < p.close ? p.open : p.close) + 1n }),
    ],
    [
      'low above high',
      'ohlc_inconsistent',
      (p) => ({ ...p, low: p.high + 1n }),
    ],
    [
      'taker-buy base above volume',
      'volume_inconsistent',
      (p) => ({ ...p, takerBase: p.volume + 1n }),
    ],
    [
      'taker-buy quote above quote volume',
      'volume_inconsistent',
      (p) => ({ ...p, takerQuote: p.quote + 1n }),
    ],
  ];

  it.each(mutations)('%s gives %s', (_, reason, mutate) => {
    fc.assert(
      fc.property(barArbitrary, (bar) => {
        const fields = barRow(bar, mutate(consistentPrices(bar)));

        expect(reasonOf(fields, bar.interval)).toBe(reason);
      }),
      { numRuns: 500 },
    );
  });

  it('accepts zero-volume bars with o = h = l = c', () => {
    fc.assert(
      fc.property(barArbitrary, (bar) => {
        const price = bar.low;
        const prices: Prices = {
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0n,
          takerBase: 0n,
          quote: 0n,
          takerQuote: 0n,
        };

        expect(
          reasonOf(barRow({ ...bar, tradeCount: 0 }, prices), bar.interval),
        ).toBe('accepted');
      }),
      { numRuns: 500 },
    );
  });
});

describe('Decimal, not float (criterion 9)', () => {
  it('all eight money fields of an accepted candle are Decimal instances', () => {
    const candle = accepted(row());

    for (const field of MONEY_FIELDS) {
      expect(candle[field], field).toBeInstanceOf(Decimal);
    }
    expect(typeof candle.tradeCount).toBe('number');
  });

  it('low = "1.00000000000000001" with open = "1" is ohlc_inconsistent', () => {
    const fields = row({
      1: '1',
      2: '2',
      3: '1.00000000000000001',
      4: '1.5',
    });

    // A float compare would accept it: the two parse to the same double.
    expect(Number('1.00000000000000001') > Number('1')).toBe(false);
    expect(reasonOf(fields)).toBe('ohlc_inconsistent');
  });

  describe.each(INTERVALS)('interval %s', (interval) => {
    const step = INTERVAL_MS[interval];
    const openMs = ANCHOR_MS;

    it('2026-10-01T00:00Z is aligned to it', () => {
      expect(openMs % step).toBe(0);
    });

    it.each(['ms', 'us'] as const)(
      'accepts the aligned bar with close = open + interval - 1 in %s',
      (unit) => {
        const fields = row({ 0: openMs, 6: openMs + step - 1 });
        const candle = accepted(
          unit === 'us' ? toMicros(fields) : fields,
          interval,
        );

        expect(candle.openTimeMs).toBe(openMs);
        expect(candle.closeTimeMs).toBe(openMs + step - 1);
        expect(candle.interval).toBe(interval);
      },
    );

    it.each([
      ['one ms late', 1, 'ms'],
      ['one minute late', 60_000, 'ms'],
      ['one ms late', 1, 'us'],
    ] as const)('rejects an open time %s in %s', (_, offset, unit) => {
      const fields = row({ 0: openMs + offset, 6: openMs + offset + step - 1 });

      expect(
        reasonOf(unit === 'us' ? toMicros(fields) : fields, interval),
      ).toBe('misaligned_open_time');
    });

    it('rejects a µs open time with a sub-millisecond remainder', () => {
      const fields: unknown[] = [
        openMs * 1000 + 500,
        ...row().slice(1, 6),
        openMs * 1000 + 500 + step * 1000 - 1,
        ...row().slice(7),
      ];

      expect(reasonOf(fields, interval)).toBe('misaligned_open_time');
    });

    it.each(['ms', 'us'] as const)(
      'rejects a close time one unit off either way in %s',
      (unit) => {
        const base = row({ 0: openMs, 6: openMs + step - 1 });
        const fields = unit === 'us' ? toMicros(base) : base;
        const close = fields[6] as number;

        expect(
          reasonOf(
            [...fields.slice(0, 6), close + 1, ...fields.slice(7)],
            interval,
          ),
        ).toBe('bad_close_time');
        expect(
          reasonOf(
            [...fields.slice(0, 6), close - 1, ...fields.slice(7)],
            interval,
          ),
        ).toBe('bad_close_time');
      },
    );
  });
});
