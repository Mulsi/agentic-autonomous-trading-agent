import {
  type Candle,
  type KlineInterval,
  normalizeKlineRow,
} from '../../../src/market-data/normalizer.js';
import {
  freshness,
  freshnessBlocksEntries,
  type KlineBatch,
  missingRanges,
  validateKlines,
  type ValidateKlinesOptions,
} from '../../../src/market-data/validator.js';
import {
  ANCHOR_MS,
  bulkCsvRows,
  candleView,
  FIFTEEN_MINUTES_MS as STEP,
  FIXTURE_BARS,
  metricsOpenTimesMs,
  msRow,
  restJsonRows,
} from '../../fixtures/market-data/klines.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const END = ANCHOR_MS + FIXTURE_BARS * STEP;

/** Options over the fixture day's first eight 15m slots, all closed. */
function options(
  overrides: Partial<ValidateKlinesOptions> = {},
): ValidateKlinesOptions {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    range: { fromMs: ANCHOR_MS, toMs: END },
    asOfMs: END,
    outlier: { window: 4, maxRangeMultiple: 5 },
    ...overrides,
  };
}

const openTimes = (candles: readonly Candle[]): number[] =>
  candles.map((candle) => candle.openTimeMs);

const views = (candles: readonly Candle[]) => candles.map(candleView);

const slot = (index: number): number => ANCHOR_MS + index * STEP;

/** A calm bar at a level: range 1% of the level, closing at the level. */
function calm(index: number, level = 100): unknown[] {
  return msRow(slot(index), STEP, {
    open: String(level),
    high: String(level + level / 200),
    low: String(level - level / 200),
    close: String(level),
  });
}

function candleFrom(fields: unknown): Candle {
  const result = normalizeKlineRow(fields, 'BTCUSDT', '15m');
  if (!result.ok) throw new Error(result.reason);
  return result.candle;
}

describe('the fixture validates clean', () => {
  it.each([
    ['REST JSON (ms)', restJsonRows],
    ['bulk CSV (µs)', bulkCsvRows],
  ])('%s gives eight candles, nothing missing or quarantined', (_, rows) => {
    const batch = validateKlines(rows(), options());

    expect(openTimes(batch.candles)).toEqual(
      Array.from({ length: FIXTURE_BARS }, (__, i) => slot(i)),
    );
    expect(batch.quarantined).toEqual([]);
    expect(batch.missing).toEqual([]);
    expect(batch.open).toEqual([]);
    expect(batch.duplicatesCollapsed).toBe(0);
    expect(batch.outOfOrder).toBe(0);
    expect(batch.unjudged).toEqual(openTimes(batch.candles).slice(0, 5));
  });
});

describe('duplicates (criterion 10)', () => {
  it('two identical rows give one candle and duplicatesCollapsed = 1', () => {
    const [first] = restJsonRows();
    const batch = validateKlines([first, first], options());

    expect(openTimes(batch.candles)).toEqual([ANCHOR_MS]);
    expect(batch.duplicatesCollapsed).toBe(1);
    expect(batch.quarantined).toEqual([]);
  });

  it('the ms and µs forms of one bar count as identical', () => {
    const batch = validateKlines(
      [restJsonRows()[0], bulkCsvRows()[0]],
      options(),
    );

    expect(openTimes(batch.candles)).toEqual([ANCHOR_MS]);
    expect(batch.duplicatesCollapsed).toBe(1);
    expect(batch.quarantined).toEqual([]);
  });

  it('copies differing only in the 18th significant digit of close are both duplicate_conflict', () => {
    const [first] = restJsonRows() as [unknown[]];
    const a = [...first];
    const b = [...first];
    a[4] = '60100.250000000001';
    b[4] = '60100.250000000002';
    const batch = validateKlines([a, b], options());

    expect(batch.candles).toEqual([]);
    expect(batch.duplicatesCollapsed).toBe(0);
    expect(batch.quarantined.map(({ reason }) => reason)).toEqual([
      'duplicate_conflict',
      'duplicate_conflict',
    ]);
    expect(batch.quarantined.map(({ raw }) => raw)).toEqual([a, b]);
    expect(batch.quarantined.every(({ candle }) => candle !== undefined)).toBe(
      true,
    );
    expect(batch.missing).toEqual([{ fromMs: ANCHOR_MS, toMs: END }]);
  });

  it('a malformed row sharing a slot does not stop the valid row', () => {
    const [first] = restJsonRows() as [unknown[]];
    const broken = [...first];
    broken[5] = 'not a number';
    const batch = validateKlines([broken, first], options());

    expect(openTimes(batch.candles)).toEqual([ANCHOR_MS]);
    expect(batch.quarantined).toEqual([
      { reason: 'bad_number', raw: broken, openTimeMs: ANCHOR_MS },
    ]);
    expect(batch.duplicatesCollapsed).toBe(0);
  });
});

describe('order (criterion 11)', () => {
  const rows = restJsonRows();

  it('reverse input gives the same candles, missing and open, counting rows - 1', () => {
    const asOfMs = slot(7) + 60_000; // bar 7 is still open
    const forward = validateKlines(rows, options({ asOfMs }));
    const reverse = validateKlines([...rows].reverse(), options({ asOfMs }));

    expect(views(reverse.candles)).toEqual(views(forward.candles));
    expect(views(reverse.open)).toEqual(views(forward.open));
    expect(reverse.missing).toEqual(forward.missing);
    expect(forward.open).toHaveLength(1);
    expect(reverse.outOfOrder).toBe(rows.length - 1);
    expect(forward.outOfOrder).toBe(0);
  });

  it('a single swapped pair counts once and is not quarantined', () => {
    const swapped = [rows[0], rows[2], rows[1], ...rows.slice(3)];
    const batch = validateKlines(swapped, options());

    expect(batch.outOfOrder).toBe(1);
    expect(batch.quarantined).toEqual([]);
    expect(openTimes(batch.candles)).toEqual(
      [...openTimes(batch.candles)].sort((a, b) => a - b),
    );
  });
});

describe('range and future (criterion 12)', () => {
  const rows = restJsonRows();

  it('a row before fromMs or at toMs is outside_range', () => {
    const batch = validateKlines(
      rows,
      options({ range: { fromMs: slot(1), toMs: slot(7) } }),
    );

    expect(
      batch.quarantined.map(({ reason, openTimeMs }) => [reason, openTimeMs]),
    ).toEqual([
      ['outside_range', slot(0)],
      ['outside_range', slot(7)],
    ]);
    expect(openTimes(batch.candles)).toEqual([1, 2, 3, 4, 5, 6].map(slot));
    expect(batch.quarantined[0]?.candle?.openTimeMs).toBe(slot(0));
  });

  it('a row opening after asOfMs is future_bar', () => {
    const asOfMs = slot(6) - 1;
    const batch = validateKlines(rows, options({ asOfMs }));

    expect(
      batch.quarantined.map(({ reason, openTimeMs }) => [reason, openTimeMs]),
    ).toEqual([
      ['future_bar', slot(6)],
      ['future_bar', slot(7)],
    ]);
  });

  it('a future row in a slot also outside the range is still future_bar', () => {
    const batch = validateKlines(
      rows,
      options({ range: { fromMs: ANCHOR_MS, toMs: slot(4) }, asOfMs: slot(5) }),
    );

    expect(
      batch.quarantined.map(({ reason, openTimeMs }) => [reason, openTimeMs]),
    ).toEqual([
      ['outside_range', slot(4)],
      ['outside_range', slot(5)],
      ['future_bar', slot(6)],
      ['future_bar', slot(7)],
    ]);
  });

  it.each([
    ['opening exactly at asOfMs', slot(7)],
    ['in the middle of its interval', slot(7) + 60_000],
    ['at its own close time', slot(8) - 1],
  ])('a bar %s is open, not candle, quarantined or missing', (_, asOfMs) => {
    const batch = validateKlines(rows, options({ asOfMs }));

    expect(openTimes(batch.open)).toEqual([slot(7)]);
    expect(openTimes(batch.candles)).not.toContain(slot(7));
    expect(openTimes(batch.checked)).not.toContain(slot(7));
    expect(batch.quarantined).toEqual([]);
    expect(batch.missing).toEqual([]);
  });

  it('the bar closes once asOfMs passes its close time', () => {
    const batch = validateKlines(rows, options({ asOfMs: slot(8) }));

    expect(batch.open).toEqual([]);
    expect(openTimes(batch.candles)).toContain(slot(7));
  });
});

describe('missing (criterion 13)', () => {
  it('the metrics fixture has exactly one gap, [00:35, 01:25)', () => {
    const times = metricsOpenTimesMs();
    const ranges = missingRanges(times, {
      fromMs: ANCHOR_MS,
      toMs: Date.UTC(2026, 9, 1, 2, 5),
      intervalMs: FIVE_MINUTES,
    });

    expect(times[0]).toBe(ANCHOR_MS);
    expect(ranges).toEqual([
      {
        fromMs: Date.UTC(2026, 9, 1, 0, 35),
        toMs: Date.UTC(2026, 9, 1, 1, 25),
      },
    ]);
    expect(ranges[0]).toEqual({ fromMs: 1790814900000, toMs: 1790817900000 });
  });

  it('an empty batch over a closed range gives one range covering it', () => {
    const batch = validateKlines([], options());

    expect(batch.missing).toEqual([{ fromMs: ANCHOR_MS, toMs: END }]);
  });

  it('leading and trailing gaps inside the range are reported', () => {
    const rows = restJsonRows().slice(2, 5);
    const batch = validateKlines(rows, options());

    expect(batch.missing).toEqual([
      { fromMs: slot(0), toMs: slot(2) },
      { fromMs: slot(5), toMs: END },
    ]);
  });

  it('expected slots stop at asOfMs', () => {
    const asOfMs = slot(3) + 60_000;
    const batch = validateKlines(
      [],
      options({ range: { fromMs: ANCHOR_MS, toMs: slot(96) }, asOfMs }),
    );

    expect(batch.missing).toEqual([{ fromMs: ANCHOR_MS, toMs: slot(3) }]);
  });

  it('a range that has not closed any slot has nothing missing', () => {
    const batch = validateKlines([], options({ asOfMs: ANCHOR_MS + STEP - 1 }));

    expect(batch.missing).toEqual([]);
  });

  it('missingRanges ignores times off the grid or outside the range', () => {
    expect(
      missingRanges([ANCHOR_MS + 1, ANCHOR_MS - FIVE_MINUTES, ANCHOR_MS], {
        fromMs: ANCHOR_MS,
        toMs: ANCHOR_MS + 2 * FIVE_MINUTES,
        intervalMs: FIVE_MINUTES,
      }),
    ).toEqual([
      { fromMs: ANCHOR_MS + FIVE_MINUTES, toMs: ANCHOR_MS + 2 * FIVE_MINUTES },
    ]);
  });
});

describe('outliers (criterion 14, window 4, multiple 5)', () => {
  const calmSeries = (count: number, level = 100, from = 0): unknown[][] =>
    Array.from({ length: count }, (_, i) => calm(from + i, level));

  function verdict(batch: KlineBatch, openTimeMs: number): string {
    if (
      batch.quarantined.some(
        (r) => r.reason === 'outlier' && r.openTimeMs === openTimeMs,
      )
    ) {
      return 'outlier';
    }
    if (batch.unjudged.includes(openTimeMs)) return 'unjudged';
    return openTimes(batch.candles).includes(openTimeMs)
      ? 'accepted'
      : 'absent';
  }

  it('a bar whose true range is 20 times the median is an outlier', () => {
    const spike = msRow(slot(6), STEP, {
      open: '100',
      high: '110',
      low: '90',
      close: '100',
    });
    const rows = [...calmSeries(6), spike, calm(7)];
    const batch = validateKlines(rows, options());
    const record = batch.quarantined.find(({ reason }) => reason === 'outlier');

    expect(batch.quarantined).toHaveLength(1);
    expect(record?.openTimeMs).toBe(slot(6));
    expect(record?.raw).toBe(spike);
    expect(record?.candle?.high.toFixed()).toBe('110');
    expect(batch.missing).toEqual([{ fromMs: slot(6), toMs: slot(7) }]);
    expect(openTimes(batch.checked)).toContain(slot(6));
    expect(openTimes(batch.candles)).not.toContain(slot(6));
    expect(verdict(batch, slot(7))).toBe('accepted');
  });

  it('a genuine level shift flags at most the shift bar and the one after it', () => {
    const shift = msRow(slot(6), STEP, {
      open: '100',
      high: '200',
      low: '100',
      close: '200',
    });
    const rows = [...calmSeries(6), shift, ...calmSeries(12, 200, 7)];
    const batch = validateKlines(
      rows,
      options({
        range: { fromMs: ANCHOR_MS, toMs: slot(19) },
        asOfMs: slot(19),
      }),
    );

    expect(verdict(batch, slot(6))).toBe('outlier');
    for (let i = 8; i < 19; i += 1) {
      expect(verdict(batch, slot(i)), `bar ${i}`).toBe('accepted');
    }
    expect(
      batch.quarantined.every(({ openTimeMs }) =>
        [slot(6), slot(7)].includes(openTimeMs ?? -1),
      ),
    ).toBe(true);
  });

  it('a sustained rise in volatility flags only the first bars, up to half a window plus one', () => {
    const wide = (i: number): unknown[] =>
      msRow(slot(i), STEP, {
        open: '100',
        high: '120',
        low: '80',
        close: '100',
      });
    const rows = [
      ...calmSeries(6),
      ...Array.from({ length: 10 }, (_, i) => wide(6 + i)),
    ];
    const batch = validateKlines(
      rows,
      options({
        range: { fromMs: ANCHOR_MS, toMs: slot(16) },
        asOfMs: slot(16),
      }),
    );
    const outliers = batch.quarantined.filter(
      ({ reason }) => reason === 'outlier',
    );

    // The first wide bars stand out against calm ones; once half the window
    // is wide, the median has moved and every later bar is accepted.
    expect(outliers.length).toBeLessThanOrEqual(2);
    for (let i = 8; i < 16; i += 1) {
      expect(verdict(batch, slot(i)), `bar ${i}`).toBe('accepted');
    }
  });

  it('the first window + 1 bars of a series with no history are unjudged and accepted', () => {
    const batch = validateKlines(calmSeries(8), options());

    expect(batch.unjudged).toEqual([0, 1, 2, 3, 4].map(slot));
    expect(openTimes(batch.candles)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map(slot),
    );
  });

  it('an unjudged extreme bar is still accepted and listed', () => {
    const spike = msRow(slot(2), STEP, {
      open: '100',
      high: '150',
      low: '50',
      close: '100',
    });
    const batch = validateKlines([calm(0), calm(1), spike, calm(3)], options());

    expect(verdict(batch, slot(2))).toBe('unjudged');
    expect(batch.quarantined).toEqual([]);
  });

  it('with window + 1 bars of history, no batch bar is unjudged', () => {
    const history = calmSeries(5).map(candleFrom);
    const rows = calmSeries(8, 100, 5);
    const batch = validateKlines(
      rows,
      options({
        range: { fromMs: slot(5), toMs: slot(13) },
        asOfMs: slot(13),
        history,
      }),
    );

    expect(batch.unjudged).toEqual([]);
    expect(batch.candles).toHaveLength(8);
  });

  it('history can flag the first batch bar', () => {
    const history = calmSeries(5).map(candleFrom);
    const spike = msRow(slot(5), STEP, {
      open: '100',
      high: '110',
      low: '90',
      close: '100',
    });
    const batch = validateKlines(
      [spike],
      options({
        range: { fromMs: slot(5), toMs: slot(6) },
        asOfMs: slot(6),
        history,
      }),
    );

    expect(batch.quarantined.map(({ reason }) => reason)).toEqual(['outlier']);
  });
});

describe('the outlier rule after a run of zero-range bars (round 2)', () => {
  /** A zero-range bar at 100: o = h = l = c = the previous close. */
  const flat = (i: number): unknown[] =>
    msRow(slot(i), STEP, {
      open: '100',
      high: '100',
      low: '100',
      close: '100',
    });

  function run(rows: unknown[][], window: number, multiple: number) {
    return validateKlines(
      rows,
      options({
        range: { fromMs: slot(0), toMs: slot(rows.length) },
        asOfMs: slot(rows.length),
        outlier: { window, maxRangeMultiple: multiple },
      }),
    );
  }

  it('10 flat bars then 10 normal ones (window 8, multiple 10): nothing is flagged', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => flat(i)),
      ...Array.from({ length: 10 }, (_, i) => calm(10 + i)),
    ];
    const batch = run(rows, 8, 10);

    expect(batch.quarantined).toEqual([]);
    expect(batch.missing).toEqual([]);
    expect(openTimes(batch.candles)).toEqual(
      Array.from({ length: 20 }, (_, i) => slot(i)),
    );
    // 0 to 8 are warm-up. 9 to 13 have a zero median: at slot 13 five of the
    // eight earlier ratios are still zero. From slot 14 the median is
    // non-zero and the normal bars are judged and accepted.
    expect(batch.unjudged).toEqual(
      Array.from({ length: 14 }, (_, i) => slot(i)),
    );
  });

  it("slots 10 to 13 of the reviewers' probe, flagged before round 2, are accepted", () => {
    // The probe from the round-1 reviews, recomputed by hand: at slots 10 to
    // 13 the window median is 0 and each calm ratio 0.01 > 10 x 0. Those four
    // slots are exactly the ones that are now unjudged instead.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => flat(i)),
      ...Array.from({ length: 10 }, (_, i) => calm(10 + i)),
    ];
    const batch = run(rows, 8, 10);

    for (const i of [10, 11, 12, 13]) {
      expect(batch.unjudged).toContain(slot(i));
      expect(openTimes(batch.candles)).toContain(slot(i));
    }
  });

  it('a genuine spike right after a flat run is accepted and listed as unjudged', () => {
    // Decision: with a zero median there is no scale, so the spike cannot be
    // judged. It still passed every row and batch check. The bars after it
    // are judged again once the median is non-zero (slot 14).
    const spike = msRow(slot(10), STEP, {
      open: '100',
      high: '110',
      low: '90',
      close: '100',
    });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => flat(i)),
      spike,
      ...Array.from({ length: 9 }, (_, i) => calm(11 + i)),
    ];
    const batch = run(rows, 8, 10);

    expect(batch.quarantined).toEqual([]);
    expect(openTimes(batch.candles)).toContain(slot(10));
    expect(batch.unjudged).toEqual(
      Array.from({ length: 14 }, (_, i) => slot(i)),
    );
  });

  it('a spike once the median is non-zero again is still flagged', () => {
    const spike = msRow(slot(16), STEP, {
      open: '100',
      high: '110',
      low: '90',
      close: '100',
    });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => flat(i)),
      ...Array.from({ length: 6 }, (_, i) => calm(10 + i)),
      spike,
      calm(17),
    ];
    const batch = run(rows, 8, 10);

    expect(
      batch.quarantined.map(({ reason, openTimeMs }) => [reason, openTimeMs]),
    ).toEqual([['outlier', slot(16)]]);
  });

  it('a zero-median bar still goes through every other check', () => {
    const rows: unknown[][] = [
      ...Array.from({ length: 10 }, (_, i) => flat(i)),
      msRow(slot(10), STEP, {
        open: '100',
        high: '99',
        low: '98',
        close: '100',
      }),
    ];
    const batch = run(rows, 8, 10);

    expect(batch.quarantined.map(({ reason }) => reason)).toEqual([
      'ohlc_inconsistent',
    ]);
    expect(batch.missing).toEqual([{ fromMs: slot(10), toMs: slot(11) }]);
  });
});

describe('the outlier rule, pinned at its boundary', () => {
  /** Bars at slots 0.., given as [open, high, low, close]. */
  function judge(
    bars: readonly (readonly [string, string, string, string])[],
    window: number,
  ): string[] {
    const rows = bars.map(([open, high, low, close], i) =>
      msRow(slot(i), STEP, { open, high, low, close }),
    );
    const batch = validateKlines(
      rows,
      options({
        range: { fromMs: slot(0), toMs: slot(bars.length) },
        asOfMs: slot(bars.length),
        outlier: { window, maxRangeMultiple: 1 },
      }),
    );
    return rows.map((_, i) => {
      if (batch.unjudged.includes(slot(i))) return 'unjudged';
      return batch.quarantined.some(
        (r) => r.reason === 'outlier' && r.openTimeMs === slot(i),
      )
        ? 'outlier'
        : 'accepted';
    });
  }

  const start = ['100', '100', '100', '100'] as const;
  const range2 = ['100', '101', '99', '100'] as const; // ratio 2/100

  it('divides the true range by the previous close, not the bar close', () => {
    // 2 / 100 equals the median and is accepted; 2 / 98 would be above it.
    expect(judge([start, range2, ['100', '100', '98', '98']], 1)).toEqual([
      'unjudged',
      'unjudged',
      'accepted',
    ]);
  });

  it('counts a gap from the previous close as range', () => {
    expect(judge([start, range2, ['102', '102', '102', '102']], 1)).toEqual([
      'unjudged',
      'unjudged',
      'accepted',
    ]);
    expect(
      judge([start, range2, ['102.01', '102.01', '102.01', '102.01']], 1),
    ).toEqual(['unjudged', 'unjudged', 'outlier']);
  });

  it('counts a gap down to the previous close as range', () => {
    expect(judge([start, range2, ['98', '98', '98', '98']], 1)).toEqual([
      'unjudged',
      'unjudged',
      'accepted',
    ]);
    expect(
      judge([start, range2, ['97.99', '97.99', '97.99', '97.99']], 1),
    ).toEqual(['unjudged', 'unjudged', 'outlier']);
  });

  it('flags only a ratio strictly above the multiple times the median', () => {
    expect(judge([start, range2, ['100', '101', '99', '100']], 1)).toEqual([
      'unjudged',
      'unjudged',
      'accepted',
    ]);
    expect(
      judge([start, range2, ['100', '101.000001', '99', '100']], 1),
    ).toEqual(['unjudged', 'unjudged', 'outlier']);
  });

  it('takes the mean of the two middle ratios for an even window', () => {
    const range1 = ['100', '100.5', '99.5', '100'] as const; // 1/100
    const range3 = ['100', '101.5', '98.5', '100'] as const; // 3/100
    // Median of 0.01 and 0.03 is 0.02: 0.02 is accepted, 0.0201 is not.
    expect(judge([start, range1, range3, range2], 2)).toEqual([
      'unjudged',
      'unjudged',
      'unjudged',
      'accepted',
    ]);
    expect(
      judge([start, range1, range3, ['100', '101.01', '99', '100']], 2),
    ).toEqual(['unjudged', 'unjudged', 'unjudged', 'outlier']);
  });
});

describe('argument errors throw (criterion 15)', () => {
  const history = [calm(0), calm(1)].map(candleFrom);
  const later = { range: { fromMs: slot(2), toMs: slot(4) }, asOfMs: slot(4) };

  it.each<[string, Partial<ValidateKlinesOptions>, RegExp]>([
    ['an unknown interval', { interval: '5m' as KlineInterval }, /interval/],
    [
      'an unaligned range.fromMs',
      { range: { fromMs: ANCHOR_MS + 1, toMs: END } },
      /range\.fromMs/,
    ],
    [
      'an unaligned range.toMs',
      { range: { fromMs: ANCHOR_MS, toMs: END - 1 } },
      /range\.toMs/,
    ],
    [
      'fromMs > toMs',
      { range: { fromMs: END, toMs: ANCHOR_MS } },
      /range\.fromMs/,
    ],
    ['a non-integer asOfMs', { asOfMs: END + 0.5 }, /asOfMs/],
    ['an unsafe asOfMs', { asOfMs: Number.MAX_SAFE_INTEGER + 1 }, /asOfMs/],
    [
      'window 0',
      { outlier: { window: 0, maxRangeMultiple: 5 } },
      /outlier\.window/,
    ],
    [
      'window 1.5',
      { outlier: { window: 1.5, maxRangeMultiple: 5 } },
      /outlier\.window/,
    ],
    [
      'maxRangeMultiple 0',
      { outlier: { window: 4, maxRangeMultiple: 0 } },
      /outlier\.maxRangeMultiple/,
    ],
    [
      'maxRangeMultiple Infinity',
      { outlier: { window: 4, maxRangeMultiple: Infinity } },
      /outlier\.maxRangeMultiple/,
    ],
    [
      'maxRangeMultiple NaN',
      { outlier: { window: 4, maxRangeMultiple: NaN } },
      /outlier\.maxRangeMultiple/,
    ],
    [
      'history not strictly ascending',
      { ...later, history: [history[1], history[0]] as Candle[] },
      /history/,
    ],
    [
      'history with a repeated open time',
      { ...later, history: [history[0], history[0]] as Candle[] },
      /history/,
    ],
    [
      'history of another symbol',
      { ...later, history: history.map((c) => ({ ...c, symbol: 'ETHUSDT' })) },
      /history/,
    ],
    [
      'history of another interval',
      {
        ...later,
        history: history.map((c) => ({ ...c, interval: '1h' as const })),
      },
      /history/,
    ],
    [
      'history that does not end before range.fromMs',
      { ...later, range: { fromMs: slot(1), toMs: slot(4) }, history },
      /history/,
    ],
  ])('%s', (_, overrides, message) => {
    let thrown: unknown;
    try {
      validateKlines([], options(overrides));
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof TypeError || thrown instanceof RangeError).toBe(
      true,
    );
    expect((thrown as Error).message).toMatch(message);
  });

  it('valid history does not throw', () => {
    expect(() =>
      validateKlines([], options({ ...later, history })),
    ).not.toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'freshness throws on maxAgeMs %s, naming it',
    (maxAgeMs) => {
      expect(() => freshness(ANCHOR_MS, END, maxAgeMs)).toThrow(RangeError);
      expect(() => freshness(ANCHOR_MS, END, maxAgeMs)).toThrow(/maxAgeMs/);
    },
  );

  it('freshness throws on a non-integer asOfMs, naming it', () => {
    expect(() => freshness(ANCHOR_MS, END + 0.5, 1000)).toThrow(/asOfMs/);
  });

  it('missingRanges throws on a non-positive intervalMs, naming it', () => {
    expect(() =>
      missingRanges([], { fromMs: 0, toMs: 10, intervalMs: 0 }),
    ).toThrow(/intervalMs/);
  });

  it('no row content throws', () => {
    const rows: unknown[] = [
      null,
      undefined,
      42,
      'text',
      {},
      [],
      new Array(12),
      Array.from({ length: 12 }, () => ({})),
      [Symbol('x'), ...restJsonRows()[0]!.slice(1)],
      [1n, ...restJsonRows()[0]!.slice(1)],
    ];

    expect(() => validateKlines(rows, options())).not.toThrow();
    expect(validateKlines(rows, options()).quarantined).toHaveLength(
      rows.length,
    );
  });
});

describe('freshness (criterion 22, pinned cases)', () => {
  const maxAgeMs = 60_000;
  const close = END - 1;

  it('age exactly maxAgeMs is FRESH', () => {
    expect(freshness(close, close + 1 + maxAgeMs, maxAgeMs)).toEqual({
      status: 'FRESH',
      ageMs: maxAgeMs,
    });
  });

  it('age maxAgeMs + 1 is STALE', () => {
    expect(freshness(close, close + 2 + maxAgeMs, maxAgeMs)).toEqual({
      status: 'STALE',
      ageMs: maxAgeMs + 1,
    });
  });

  it('a bar that just closed has age 0', () => {
    expect(freshness(close, close + 1, maxAgeMs)).toEqual({
      status: 'FRESH',
      ageMs: 0,
    });
  });

  it('newestCloseMs = asOfMs is UNKNOWN clock_skew', () => {
    expect(freshness(close, close, maxAgeMs)).toEqual({
      status: 'UNKNOWN',
      reason: 'clock_skew',
    });
  });

  it('no data is UNKNOWN no_data', () => {
    expect(freshness(undefined, END, maxAgeMs)).toEqual({
      status: 'UNKNOWN',
      reason: 'no_data',
    });
  });

  it('only FRESH lets entries through', () => {
    expect(freshnessBlocksEntries({ status: 'FRESH', ageMs: 0 })).toBe(false);
    expect(freshnessBlocksEntries({ status: 'STALE', ageMs: 1 })).toBe(true);
    expect(
      freshnessBlocksEntries({ status: 'UNKNOWN', reason: 'no_data' }),
    ).toBe(true);
    expect(
      freshnessBlocksEntries({ status: 'UNKNOWN', reason: 'clock_skew' }),
    ).toBe(true);
  });
});
