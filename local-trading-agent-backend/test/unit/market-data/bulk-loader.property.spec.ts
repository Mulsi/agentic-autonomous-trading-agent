import fc from 'fast-check';
import { bulkFile } from '../../../src/market-data/binance-vision.js';
import {
  loadKlines,
  type LoadRequest,
} from '../../../src/market-data/bulk-loader.js';
import type { KlineInterval } from '../../../src/market-data/normalizer.js';
import {
  validateKlines,
  type KlineBatch,
  type ValidateKlinesOptions,
} from '../../../src/market-data/validator.js';
import {
  checksumBody,
  csvText,
  DAY_MS,
  FakeHttp,
  klineLine,
  RecordingSink,
  SLOTS_PER_DAY,
  walkLines,
} from '../../fixtures/market-data/bulk.js';
import { zipOf } from '../../fixtures/market-data/zip-writer.js';

// S1b criterion 18: history is chained from file to file, and a chained run
// judges every bar exactly as one validateKlines call over the whole range
// would (D13). validateKlines is wrapped in a spy that records each call.

vi.mock(import('../../../src/market-data/validator.js'), async (original) => {
  const actual = await original();
  return { ...actual, validateKlines: vi.fn(actual.validateKlines) };
});

const calls = (): { options: ValidateKlinesOptions; batch: KlineBatch }[] =>
  vi.mocked(validateKlines).mock.calls.map((call, index) => ({
    options: call[1],
    batch: vi.mocked(validateKlines).mock.results[index]?.value as KlineBatch,
  }));

beforeEach(() => {
  vi.mocked(validateKlines).mockClear();
});

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03'];
const FIRST_DAY = Date.UTC(2026, 9, 1);

function request(overrides: Partial<LoadRequest> = {}): LoadRequest {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    period: 'daily',
    from: DAYS[0] as string,
    to: DAYS[2] as string,
    asOfMs: FIRST_DAY + 40 * DAY_MS,
    outlier: { window: 4, maxRangeMultiple: 5 },
    dryRun: false,
    ...overrides,
  };
}

describe('history is chained (criterion 18)', () => {
  const files = DAYS.map((day) => bulkFile('BTCUSDT', '15m', 'daily', day));

  function serve(http: FakeHttp): void {
    files.forEach((file, index) => {
      http.serve(
        file,
        csvText(walkLines(file.range.fromMs, SLOTS_PER_DAY, index + 11)),
      );
    });
  }

  it("passes the first file's checked output as the second file's history", async () => {
    const http = new FakeHttp();
    serve(http);

    await loadKlines(request(), { http, sink: new RecordingSink() });

    const [first, second, third] = calls();
    expect(first?.options.history).toEqual([]);
    expect(second?.options.history).toEqual(first?.batch.checked);
    expect(second?.options.history).toHaveLength(96);
    expect(third?.options.history).toEqual(second?.batch.checked);
  });

  it("gives the third file the first file's checked output when the middle file fails", async () => {
    const http = new FakeHttp();
    serve(http);
    const middle = files[1];
    if (middle === undefined) throw new Error('no middle file');
    http.responses.set(middle.checksumUrl, {
      status: 200,
      body: checksumBody(zipOf(middle.csvName, 'other'), middle.zipName),
    });
    const sink = new RecordingSink();

    const summaries = await loadKlines(request(), { http, sink });

    expect(summaries.map((summary) => summary.status)).toEqual([
      'loaded',
      'checksum_mismatch',
      'loaded',
    ]);
    const [first, third] = calls();
    expect(calls()).toHaveLength(2);
    expect(third?.options.history).toEqual(first?.batch.checked);
    expect(sink.calls.map((call) => call.file.zipName)).toEqual([
      files[0]?.zipName,
      files[2]?.zipName,
    ]);
  });

  it('keeps enough earlier bars when one file holds fewer than window + 1', async () => {
    // 4h daily files hold 6 bars; a window of 8 needs 9.
    const http = new FakeHttp();
    for (const [index, day] of DAYS.entries()) {
      const file = bulkFile('BTCUSDT', '4h', 'daily', day);
      http.serve(
        file,
        csvText(walkLines(file.range.fromMs, 6, index + 3, 4 * 60 * 60 * 1000)),
      );
    }

    await loadKlines(
      request({ interval: '4h', outlier: { window: 8, maxRangeMultiple: 5 } }),
      { http, sink: new RecordingSink() },
    );

    const [first, second, third] = calls();
    expect(second?.options.history).toEqual(first?.batch.checked);
    expect(third?.options.history).toEqual([
      ...(first?.batch.checked.slice(-3) ?? []),
      ...(second?.batch.checked ?? []),
    ]);
  });
});

describe('live and replay agree (criterion 18, property)', () => {
  type Kind = 'normal' | 'spike' | 'missing' | 'malformed' | 'flat';
  const interval: KlineInterval = '1h';
  const stepMs = 60 * 60 * 1000;
  const slotsPerDay = 24;

  const series = fc.record({
    days: fc.integer({ min: 2, max: 4 }),
    window: fc.integer({ min: 1, max: 30 }),
    multiple: fc.integer({ min: 1, max: 8 }),
    bars: fc.array(
      fc.record({
        kind: fc.constantFrom<Kind>(
          'normal',
          'normal',
          'normal',
          'spike',
          'missing',
          'malformed',
          'flat',
        ),
        move: fc.integer({ min: -300, max: 300 }),
        range: fc.integer({ min: 1, max: 200 }),
      }),
      { minLength: 4 * slotsPerDay, maxLength: 4 * slotsPerDay },
    ),
  });

  function linesFor(
    bars: readonly { kind: Kind; move: number; range: number }[],
    count: number,
  ): string[] {
    const lines: string[] = [];
    let close = 6_000_000;
    for (let slot = 0; slot < count; slot += 1) {
      const bar = bars[slot] as { kind: Kind; move: number; range: number };
      const open = close;
      close = open + bar.move;
      const openTimeMs = FIRST_DAY + slot * stepMs;
      if (bar.kind === 'missing') continue;
      if (bar.kind === 'malformed') {
        lines.push(`${openTimeMs}000,broken`);
        continue;
      }
      if (bar.kind === 'flat') {
        close = open;
        lines.push(
          klineLine(
            openTimeMs,
            { open, high: open, low: open, close: open },
            stepMs,
          ),
        );
        continue;
      }
      const extra = bar.kind === 'spike' ? 50_000 : 0;
      lines.push(
        klineLine(
          openTimeMs,
          {
            open,
            close,
            high: Math.max(open, close) + bar.range + extra,
            low: Math.min(open, close) - bar.range,
          },
          stepMs,
        ),
      );
    }
    return lines;
  }

  it('the chained run accepts, flags and leaves unjudged the same bars as one batch', async () => {
    await fc.assert(
      fc.asyncProperty(series, async ({ days, window, multiple, bars }) => {
        const all = linesFor(bars, days * slotsPerDay);
        const asOfMs = FIRST_DAY + 60 * DAY_MS;
        const http = new FakeHttp();
        const dates: string[] = [];
        for (let day = 0; day < days; day += 1) {
          const date = `2026-10-0${day + 1}`;
          dates.push(date);
          const file = bulkFile('BTCUSDT', interval, 'daily', date);
          http.serve(
            file,
            csvText(
              all.filter((line) => {
                const time = Number(line.split(',')[0]) / 1000;
                return time >= file.range.fromMs && time < file.range.toMs;
              }),
            ),
          );
        }
        const outlier = { window, maxRangeMultiple: multiple };
        const summaries = await loadKlines(
          request({
            interval,
            from: dates[0] as string,
            to: dates.at(-1) as string,
            asOfMs,
            outlier,
          }),
          { http, sink: new RecordingSink() },
        );
        const chained = calls().map(({ batch }) => batch);
        vi.mocked(validateKlines).mockClear();

        const whole = validateKlines(
          all.map((line) => line.split(',')),
          {
            symbol: 'BTCUSDT',
            interval,
            range: { fromMs: FIRST_DAY, toMs: FIRST_DAY + days * DAY_MS },
            asOfMs,
            outlier,
          },
        );
        vi.mocked(validateKlines).mockClear();

        const times = (
          batches: readonly KlineBatch[],
          pick: (b: KlineBatch) => readonly number[],
        ): number[] => batches.flatMap(pick);
        const outliers = (b: KlineBatch): number[] =>
          b.quarantined
            .filter((record) => record.reason === 'outlier')
            .map((record) => record.openTimeMs as number);

        expect(summaries.every((summary) => summary.status === 'loaded')).toBe(
          true,
        );
        expect(
          times(chained, (b) => b.candles.map((c) => c.openTimeMs)),
        ).toEqual(whole.candles.map((c) => c.openTimeMs));
        expect(times(chained, outliers)).toEqual(outliers(whole));
        expect(times(chained, (b) => b.unjudged)).toEqual(whole.unjudged);
      }),
      { numRuns: 200 },
    );
  });
});
