import fc from 'fast-check';
import type { Candle } from '../../../src/market-data/normalizer.js';
import {
  freshness,
  freshnessBlocksEntries,
  type KlineBatch,
  type MissingRange,
  validateKlines,
  type ValidateKlinesOptions,
} from '../../../src/market-data/validator.js';
import {
  ANCHOR_MS,
  bulkCsvRows,
  candleView,
  FIFTEEN_MINUTES_MS as STEP,
  FIXTURE_BARS,
  restJsonRows,
} from '../../fixtures/market-data/klines.js';

// Every property runs at least 500 times. Times are 15m slots from the
// fixture anchor; slot k opens at ANCHOR_MS + k * STEP.

const RUNS = { numRuns: 500 };
const SLOTS = 24;
const slot = (k: number): number => ANCHOR_MS + k * STEP;

/** Fixed-point units of 1e-8 written as a non-negative decimal string. */
function units(n: bigint): string {
  const text = n.toString().padStart(9, '0');
  return `${text.slice(0, -8)}.${text.slice(-8)}`;
}

const priceArbitrary = fc.record({
  low: fc.bigInt({ min: 100_000_000n, max: 120_000_000n }),
  scale: fc.constantFrom(10_000n, 1_000_000n, 10_000_000n),
  openAt: fc.integer({ min: 0, max: 100 }),
  closeAt: fc.integer({ min: 0, max: 100 }),
  highAt: fc.integer({ min: 0, max: 100 }),
  volume: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  takerShare: fc.integer({ min: 0, max: 100 }),
  tradeCount: fc.nat({ max: 100_000 }),
});

type PriceParams =
  typeof priceArbitrary extends fc.Arbitrary<infer T> ? T : never;

/** A consistent kline row for slot `k`, in ms or µs. */
function barRow(k: number, unit: 'ms' | 'us', p: PriceParams): unknown[] {
  const step = p.scale;
  const open = p.low + (step * BigInt(p.openAt)) / 100n;
  const close = p.low + (step * BigInt(p.closeAt)) / 100n;
  const high = (open > close ? open : close) + (step * BigInt(p.highAt)) / 100n;
  const quote = p.volume * 2n;
  const share = BigInt(p.takerShare);
  const openMs = slot(k);
  const fields: unknown[] = [
    openMs,
    units(open),
    units(high),
    units(p.low),
    units(close),
    units(p.volume),
    openMs + STEP - 1,
    units(quote),
    p.tradeCount,
    units((p.volume * share) / 100n),
    units((quote * share) / 100n),
    '0',
  ];
  if (unit === 'us') {
    fields[0] = openMs * 1000;
    fields[6] = (openMs + STEP) * 1000 - 1;
  }
  return fields;
}

const unitArbitrary = fc.constantFrom('ms' as const, 'us' as const);

const validRow = fc
  .tuple(fc.integer({ min: -2, max: SLOTS + 2 }), unitArbitrary, priceArbitrary)
  .map(([k, unit, p]) => barRow(k, unit, p));

const junkValue = fc.oneof(
  fc.anything(),
  fc.constantFrom('0', '-1', 'x', '1e5', 60000.01, -1, 1.5, ''),
);

const mutatedRow = fc.oneof(
  fc
    .tuple(validRow, fc.integer({ min: 0, max: 11 }), junkValue)
    .map(([row, index, value]) => {
      const copy = [...row];
      copy[index] = value;
      return copy;
    }),
  fc
    .tuple(validRow, fc.integer({ min: 0, max: 11 }))
    .map(([row, length]) => row.slice(0, length)),
  validRow.map((row) => [...row, 'extra']),
);

/** Valid bars, mutated bars, anything at all, and repeated copies of them. */
const rowsArbitrary = fc
  .tuple(
    fc.array(
      fc.oneof(
        { arbitrary: validRow, weight: 6 },
        { arbitrary: mutatedRow, weight: 2 },
        { arbitrary: fc.anything(), weight: 1 },
      ),
      { maxLength: 40 },
    ),
    fc.array(fc.nat(), { maxLength: 10 }),
  )
  .map(([rows, picks]) =>
    rows.length === 0
      ? rows
      : [...rows, ...picks.map((pick) => rows[pick % rows.length])],
  );

const optionsArbitrary = fc
  .record({
    fromSlot: fc.integer({ min: 0, max: SLOTS }),
    length: fc.integer({ min: 0, max: SLOTS }),
    asOfMs: fc.integer({ min: slot(-2), max: slot(SLOTS + 3) }),
    window: fc.integer({ min: 1, max: 6 }),
    maxRangeMultiple: fc.oneof(
      fc.constantFrom(1, 2, 5, 10),
      fc.double({ min: 0.5, max: 20, noNaN: true }),
    ),
  })
  .map(
    ({
      fromSlot,
      length,
      asOfMs,
      window,
      maxRangeMultiple,
    }): ValidateKlinesOptions => ({
      symbol: 'BTCUSDT',
      interval: '15m',
      range: {
        fromMs: slot(fromSlot),
        toMs: slot(Math.min(SLOTS, fromSlot + length)),
      },
      asOfMs,
      outlier: { window, maxRangeMultiple },
    }),
  );

const openTimes = (candles: readonly Candle[]): number[] =>
  candles.map((candle) => candle.openTimeMs);

const views = (candles: readonly Candle[]) => candles.map(candleView);

function expectedSlots({ range, asOfMs }: ValidateKlinesOptions): number[] {
  const slots: number[] = [];
  for (let t = range.fromMs; t < range.toMs; t += STEP) {
    if (t + STEP <= asOfMs) slots.push(t);
  }
  return slots;
}

function expand(ranges: readonly MissingRange[]): number[] {
  return ranges.flatMap(({ fromMs, toMs }) => {
    const slots: number[] = [];
    for (let t = fromMs; t < toMs; t += STEP) slots.push(t);
    return slots;
  });
}

const isStrictlyAscending = (times: readonly number[]): boolean =>
  times.every((time, i) => i === 0 || time > (times[i - 1] as number));

function quarantineMultiset(batch: KlineBatch): string[] {
  return batch.quarantined
    .map(({ reason, openTimeMs }) => `${reason}@${openTimeMs ?? '-'}`)
    .sort();
}

function outlierTimes(batch: KlineBatch): number[] {
  return batch.quarantined
    .filter(({ reason }) => reason === 'outlier')
    .map(({ openTimeMs }) => openTimeMs as number)
    .sort((a, b) => a - b);
}

describe('every row is accounted for (criterion 16)', () => {
  it('never throws, and each row lands in exactly one bucket', () => {
    fc.assert(
      fc.property(rowsArbitrary, optionsArbitrary, (rows, options) => {
        const batch = validateKlines(rows, options);

        expect(
          batch.candles.length +
            batch.open.length +
            batch.quarantined.length +
            batch.duplicatesCollapsed,
        ).toBe(rows.length);
      }),
      RUNS,
    );
  });

  it('a quarantine record keeps the raw row as given', () => {
    fc.assert(
      fc.property(rowsArbitrary, optionsArbitrary, (rows, options) => {
        for (const record of validateKlines(rows, options).quarantined) {
          expect(rows.some((row) => Object.is(row, record.raw))).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe('explicit missing data (criterion 17)', () => {
  it('candles and missing slots are disjoint, and together are the expected slots', () => {
    fc.assert(
      fc.property(rowsArbitrary, optionsArbitrary, (rows, options) => {
        const batch = validateKlines(rows, options);
        const accepted = openTimes(batch.candles);
        const missing = expand(batch.missing);

        expect(accepted.filter((time) => missing.includes(time))).toEqual([]);
        expect([...accepted, ...missing].sort((a, b) => a - b)).toEqual(
          expectedSlots(options),
        );
      }),
      RUNS,
    );
  });

  it('missing ranges are maximal: none touches the next', () => {
    fc.assert(
      fc.property(rowsArbitrary, optionsArbitrary, (rows, options) => {
        const { missing } = validateKlines(rows, options);

        missing.forEach((range, i) => {
          expect(range.fromMs).toBeLessThan(range.toMs);
          const next = missing[i + 1];
          if (next !== undefined) expect(range.toMs).toBeLessThan(next.fromMs);
        });
      }),
      RUNS,
    );
  });
});

describe('output order (criterion 18)', () => {
  it('candles and checked are strictly ascending, candles within checked, in range and closed', () => {
    fc.assert(
      fc.property(rowsArbitrary, optionsArbitrary, (rows, options) => {
        const batch = validateKlines(rows, options);
        const checked = openTimes(batch.checked);

        expect(isStrictlyAscending(openTimes(batch.candles))).toBe(true);
        expect(isStrictlyAscending(checked)).toBe(true);
        expect(isStrictlyAscending(openTimes(batch.open))).toBe(true);
        for (const candle of batch.candles) {
          expect(batch.checked).toContain(candle);
          expect(candle.openTimeMs).toBeGreaterThanOrEqual(
            options.range.fromMs,
          );
          expect(candle.openTimeMs).toBeLessThan(options.range.toMs);
          expect(candle.closeTimeMs).toBeLessThan(options.asOfMs);
        }
        expect(checked).toEqual(
          [...openTimes(batch.candles), ...outlierTimes(batch)].sort(
            (a, b) => a - b,
          ),
        );
      }),
      RUNS,
    );
  });
});

describe('order invariance (criterion 19)', () => {
  it('any permutation gives the same result', () => {
    const permuted = rowsArbitrary.chain((rows) =>
      fc.tuple(
        fc.constant(rows),
        fc.shuffledSubarray(rows, {
          minLength: rows.length,
          maxLength: rows.length,
        }),
      ),
    );

    fc.assert(
      fc.property(permuted, optionsArbitrary, ([rows, shuffled], options) => {
        const a = validateKlines(rows, options);
        const b = validateKlines(shuffled, options);

        expect(views(b.candles)).toEqual(views(a.candles));
        expect(views(b.checked)).toEqual(views(a.checked));
        expect(views(b.open)).toEqual(views(a.open));
        expect(b.missing).toEqual(a.missing);
        expect(b.unjudged).toEqual(a.unjudged);
        expect(b.duplicatesCollapsed).toBe(a.duplicatesCollapsed);
        expect(quarantineMultiset(b)).toEqual(quarantineMultiset(a));
      }),
      RUNS,
    );
  });
});

/** A closed series: one valid bar per slot 0..n-1, as of the end of slot n-1. */
const seriesArbitrary = fc
  .array(fc.tuple(unitArbitrary, priceArbitrary), {
    minLength: 1,
    maxLength: SLOTS,
  })
  .map((bars) => bars.map(([unit, p], k) => barRow(k, unit, p)));

const outlierArbitrary = fc.record({
  window: fc.integer({ min: 1, max: 5 }),
  maxRangeMultiple: fc.constantFrom(1, 1.5, 2, 3, 5),
});

function closedOptions(
  bars: number,
  outlier: ValidateKlinesOptions['outlier'],
): ValidateKlinesOptions {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    range: { fromMs: slot(0), toMs: slot(bars) },
    asOfMs: slot(bars),
    outlier,
  };
}

type Verdict = 'accepted' | 'outlier' | 'unjudged' | 'none';

function verdictOf(batch: KlineBatch, openTimeMs: number): Verdict {
  if (outlierTimes(batch).includes(openTimeMs)) return 'outlier';
  if (batch.unjudged.includes(openTimeMs)) return 'unjudged';
  if (openTimes(batch.candles).includes(openTimeMs)) return 'accepted';
  return 'none';
}

describe('no look-ahead (criterion 20)', () => {
  it('a verdict does not change with the bars after it, present or not, whatever their values', () => {
    const arbitrary = seriesArbitrary.chain((series) =>
      fc.tuple(
        fc.constant(series),
        fc.integer({ min: 0, max: series.length - 1 }),
        fc.array(fc.tuple(unitArbitrary, priceArbitrary), {
          minLength: series.length,
          maxLength: series.length,
        }),
      ),
    );

    fc.assert(
      fc.property(
        arbitrary,
        outlierArbitrary,
        ([series, i, other], outlier) => {
          const options = closedOptions(series.length, outlier);
          const full = validateKlines(series, options);
          const cut = validateKlines(series.slice(0, i + 1), options);
          const replaced = validateKlines(
            [
              ...series.slice(0, i + 1),
              ...other
                .slice(i + 1)
                .map(([unit, p], j) => barRow(i + 1 + j, unit, p)),
            ],
            options,
          );

          for (let k = 0; k <= i; k += 1) {
            const expected = verdictOf(full, slot(k));

            expect(expected).not.toBe('none');
            expect(verdictOf(cut, slot(k))).toBe(expected);
            expect(verdictOf(replaced, slot(k))).toBe(expected);
          }
        },
      ),
      RUNS,
    );
  });

  it('a bar that closes at or after asOfMs is never in candles or checked', () => {
    fc.assert(
      fc.property(
        seriesArbitrary,
        fc.integer({ min: slot(0), max: slot(SLOTS) }),
        outlierArbitrary,
        (series, asOfMs, outlier) => {
          const batch = validateKlines(series, {
            ...closedOptions(series.length, outlier),
            asOfMs,
          });

          for (const candle of [...batch.candles, ...batch.checked]) {
            expect(candle.closeTimeMs).toBeLessThan(asOfMs);
          }
          for (const candle of batch.open) {
            expect(candle.closeTimeMs).toBeGreaterThanOrEqual(asOfMs);
          }
        },
      ),
      RUNS,
    );
  });

  it('the generators do produce outliers (a check on the test itself)', () => {
    const samples = fc.sample(fc.tuple(seriesArbitrary, outlierArbitrary), {
      numRuns: 300,
      seed: 7,
    });
    const flagged = samples.filter(
      ([series, outlier]) =>
        outlierTimes(
          validateKlines(series, closedOptions(series.length, outlier)),
        ).length > 0,
    );

    expect(flagged.length).toBeGreaterThan(20);
  });
});

describe('live and replay agree, D13 (criterion 21)', () => {
  it('one call over [from, to) equals [from, s) then [s, to) with history', () => {
    const arbitrary = fc.tuple(
      rowsArbitrary,
      fc.integer({ min: 0, max: SLOTS }),
      fc.integer({ min: 0, max: SLOTS }),
      fc.integer({ min: slot(0), max: slot(SLOTS + 2) }),
      outlierArbitrary,
    );

    fc.assert(
      fc.property(arbitrary, ([rows, a, b, asOfMs, outlier]) => {
        const [split, end] = a <= b ? [a, b] : [b, a];
        const base = {
          symbol: 'BTCUSDT',
          interval: '15m' as const,
          asOfMs,
          outlier,
        };
        const whole = validateKlines(rows, {
          ...base,
          range: { fromMs: slot(0), toMs: slot(end) },
        });
        const first = validateKlines(rows, {
          ...base,
          range: { fromMs: slot(0), toMs: slot(split) },
        });
        const second = validateKlines(rows, {
          ...base,
          range: { fromMs: slot(split), toMs: slot(end) },
          history: first.checked,
        });

        expect(views([...first.candles, ...second.candles])).toEqual(
          views(whole.candles),
        );
        expect([...outlierTimes(first), ...outlierTimes(second)]).toEqual(
          outlierTimes(whole),
        );
      }),
      RUNS,
    );
  });
});

describe('freshness (criterion 22)', () => {
  const times = fc.integer({ min: slot(0), max: slot(SLOTS * 10) });
  const maxAge = fc.integer({ min: 1, max: 10 * STEP });

  it('is FRESH exactly when the bar closed and its age is within maxAgeMs', () => {
    fc.assert(
      fc.property(
        fc.option(times, { nil: undefined }),
        times,
        maxAge,
        (newestCloseMs, asOfMs, maxAgeMs) => {
          const result = freshness(newestCloseMs, asOfMs, maxAgeMs);
          const fresh =
            newestCloseMs !== undefined &&
            newestCloseMs < asOfMs &&
            asOfMs - newestCloseMs - 1 <= maxAgeMs;

          expect(result.status === 'FRESH').toBe(fresh);
          expect(freshnessBlocksEntries(result)).toBe(!fresh);
          if (newestCloseMs === undefined) {
            expect(result).toEqual({ status: 'UNKNOWN', reason: 'no_data' });
          } else if (newestCloseMs >= asOfMs) {
            expect(result).toEqual({ status: 'UNKNOWN', reason: 'clock_skew' });
          } else {
            expect(result).toEqual({
              status: fresh ? 'FRESH' : 'STALE',
              ageMs: asOfMs - newestCloseMs - 1,
            });
          }
        },
      ),
      RUNS,
    );
  });

  it('raising asOfMs never turns STALE into FRESH', () => {
    fc.assert(
      fc.property(
        times,
        times,
        fc.nat({ max: 10 * STEP }),
        maxAge,
        (newestCloseMs, asOfMs, later, maxAgeMs) => {
          const before = freshness(newestCloseMs, asOfMs, maxAgeMs);
          const after = freshness(newestCloseMs, asOfMs + later, maxAgeMs);

          if (before.status === 'STALE') expect(after.status).toBe('STALE');
        },
      ),
      RUNS,
    );
  });
});

describe('time zone (criterion 23)', () => {
  const original = process.env.TZ;

  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('gives deep-equal results under UTC, Europe/Ljubljana and Pacific/Chatham', () => {
    const run = (): KlineBatch[] => {
      const options: ValidateKlinesOptions = {
        symbol: 'BTCUSDT',
        interval: '15m',
        range: { fromMs: ANCHOR_MS, toMs: slot(FIXTURE_BARS + 2) },
        asOfMs: slot(FIXTURE_BARS) + 60_000,
        outlier: { window: 2, maxRangeMultiple: 3 },
      };
      return [
        validateKlines(restJsonRows(), options),
        validateKlines(bulkCsvRows(), options),
      ];
    };
    const hours: number[] = [];
    const results = ['UTC', 'Europe/Ljubljana', 'Pacific/Chatham'].map(
      (zone) => {
        process.env.TZ = zone;
        hours.push(new Date(ANCHOR_MS).getHours());
        return run();
      },
    );

    // The zone change took effect: local midnight differs in each.
    expect(new Set(hours).size).toBe(3);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]?.[0]?.candles).toHaveLength(FIXTURE_BARS);
  });
});
