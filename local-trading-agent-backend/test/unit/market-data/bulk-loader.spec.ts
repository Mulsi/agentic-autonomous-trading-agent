import { pino } from 'pino';
import { hash } from 'node:crypto';
import {
  run,
  type BackfillContext,
  type BackfillDeps,
} from '../../../src/backfill.js';
import { loggerOptions } from '../../../src/config/logging.js';
import type { DatabaseIdentity } from '../../../src/db/identity.js';
import {
  BINANCE_VISION_ORIGIN,
  bulkFile,
} from '../../../src/market-data/binance-vision.js';
import { splitBulkCsv } from '../../../src/market-data/bulk-csv.js';
import { MAX_ARCHIVE_BYTES } from '../../../src/market-data/bulk-limits.js';
import {
  loadKlines,
  type CandleSink,
  type FileSummary,
  type LoadRequest,
} from '../../../src/market-data/bulk-loader.js';
import { readSingleEntry } from '../../../src/market-data/zip-entry.js';
import { captureStream } from '../../fixtures/logs.js';
import {
  checksumBody,
  csvText,
  DAY_FIXTURE,
  DAY_MS,
  FakeHttp,
  klineLine,
  readFixture,
  RecordingSink,
  sha256Hex,
  SLOTS_PER_DAY,
  STEP_MS,
  walkLines,
} from '../../fixtures/market-data/bulk.js';
import { buildZip, zipOf } from '../../fixtures/market-data/zip-writer.js';

// S1b criteria 13 to 17, 19 and 20, with a fake HttpGet and a recording fake
// CandleSink. The archive reader, the CSV splitter and the hash are wrapped in
// spies, so the tests can prove what was never called.

vi.mock(import('../../../src/market-data/zip-entry.js'), async (original) => {
  const actual = await original();
  return { ...actual, readSingleEntry: vi.fn(actual.readSingleEntry) };
});
vi.mock(import('../../../src/market-data/bulk-csv.js'), async (original) => {
  const actual = await original();
  return { ...actual, splitBulkCsv: vi.fn(actual.splitBulkCsv) };
});
vi.mock(import('node:crypto'), async (original) => {
  const actual = await original();
  // The cast keeps hash's overloads, which vi.fn's type flattens.
  return { ...actual, hash: vi.fn(actual.hash) as typeof actual.hash };
});

const DAY = '2026-10-01';
const DAY_START = Date.UTC(2026, 9, 1);
const DAY_END = DAY_START + DAY_MS;
const FILE = bulkFile('BTCUSDT', '15m', 'daily', DAY);
const DAY_CSV = readFixture(DAY_FIXTURE);

function request(overrides: Partial<LoadRequest> = {}): LoadRequest {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    period: 'daily',
    from: DAY,
    to: DAY,
    asOfMs: DAY_END + DAY_MS * 30,
    outlier: { window: 4, maxRangeMultiple: 1000 },
    dryRun: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(readSingleEntry).mockClear();
  vi.mocked(splitBulkCsv).mockClear();
  vi.mocked(hash).mockClear();
});

describe('the happy path (criterion 13)', () => {
  let summary: FileSummary;
  const http = new FakeHttp();
  const sink = new RecordingSink();

  beforeAll(async () => {
    http.serve(FILE, DAY_CSV);
    [summary] = (await loadKlines(request(), { http, sink })) as [FileSummary];
  });

  it('loads the 96-row day with a verified CHECKSUM', () => {
    expect(summary).toMatchObject({
      file: 'BTCUSDT-15m-2026-10-01.zip',
      status: 'loaded',
      checksum: 'verified',
      detail: null,
      header: false,
      rows: 96,
      accepted: 96,
      open: 0,
      quarantined: {},
      missing: [],
      duplicatesCollapsed: 0,
      outOfOrder: 0,
      timeUnits: { us: 96, ms: 0, unreadable: 0 },
      firstOpenTimeMs: 1790812800000,
      lastOpenTimeMs: 1790898300000,
      lastCloseTimeMs: 1790899199999,
      written: true,
      inserted: 96,
      alreadyStored: 0,
      storedConflicts: 0,
    });
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('calls the sink once with 96 candles', () => {
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.candles).toHaveLength(96);
    expect(sink.calls[0]?.quarantine).toEqual([]);
  });

  it('makes exactly two GETs, the CHECKSUM first, both under the origin', () => {
    expect(http.urls()).toEqual([FILE.checksumUrl, FILE.zipUrl]);
    for (const url of http.urls()) {
      expect(url.startsWith(`${BINANCE_VISION_ORIGIN}/data/spot/`)).toBe(true);
    }
  });

  it('reads a file with the documented header the same way', async () => {
    const withHeader = new FakeHttp();
    withHeader.serve(
      FILE,
      `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n${DAY_CSV}`,
    );
    const [result] = await loadKlines(request({ dryRun: true }), {
      http: withHeader,
      sink: null,
    });

    expect(result).toMatchObject({ header: true, rows: 96, accepted: 96 });
  });
});

describe('the outlier input (criterion 14)', () => {
  it('echoes the input as provisional, and marks the five warm-up bars unchecked', async () => {
    const http = new FakeHttp();
    const sink = new RecordingSink();
    http.serve(FILE, DAY_CSV);

    const [summary] = await loadKlines(
      request({ outlier: { window: 4, maxRangeMultiple: 1000 } }),
      { http, sink },
    );

    expect(summary?.outlier).toEqual({
      window: 4,
      maxRangeMultiple: 1000,
      provisional: true,
    });
    expect(summary?.unjudged).toBe(5);
    const flags = sink.calls[0]?.candles.map((stored) => stored.outlierChecked);
    expect(flags?.slice(0, 5)).toEqual([false, false, false, false, false]);
    expect(flags?.slice(5).every(Boolean)).toBe(true);
    expect(flags).toHaveLength(96);
  });

  it('refuses a multiple below 1 or a window below 1 before any request', async () => {
    const http = new FakeHttp();
    for (const outlier of [
      { window: 4, maxRangeMultiple: 0.99 },
      { window: 0, maxRangeMultiple: 5 },
      { window: 1.5, maxRangeMultiple: 5 },
      { window: 4, maxRangeMultiple: Number.POSITIVE_INFINITY },
    ]) {
      await expect(
        loadKlines(request({ outlier }), { http, sink: new RecordingSink() }),
      ).rejects.toThrow(RangeError);
    }
    expect(http.requests).toEqual([]);
  });
});

describe('verify before parse (criterion 15)', () => {
  const sink = new RecordingSink();

  function expectNothingOpened(): void {
    expect(readSingleEntry).not.toHaveBeenCalled();
    expect(splitBulkCsv).not.toHaveBeenCalled();
    expect(sink.calls).toEqual([]);
  }

  it('gives checksum_mismatch for a CHECKSUM over other bytes', async () => {
    const http = new FakeHttp();
    const zip = http.serve(FILE, DAY_CSV);
    http.responses.set(FILE.checksumUrl, {
      status: 200,
      body: checksumBody(zipOf(FILE.csvName, `${DAY_CSV}x`), FILE.zipName),
    });

    const [summary] = await loadKlines(request(), { http, sink });

    expect(summary).toMatchObject({
      status: 'checksum_mismatch',
      checksum: 'mismatch',
      sha256: sha256Hex(zip),
      rows: 0,
      written: false,
    });
    expect(hash).toHaveBeenCalledTimes(1);
    expectNothingOpened();
  });

  it('gives not_found for a CHECKSUM 404 and never requests the zip', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);
    http.responses.set(FILE.checksumUrl, { status: 404 });

    const [summary] = await loadKlines(request(), { http, sink });

    expect(summary).toMatchObject({
      status: 'not_found',
      checksum: 'not_found',
    });
    expect(http.urls()).toEqual([FILE.checksumUrl]);
    expect(hash).not.toHaveBeenCalled();
    expectNothingOpened();
  });

  it.each([
    [
      'unparseable',
      { status: 200, body: new TextEncoder().encode('not a checksum\n') },
    ],
    [
      'for another file',
      {
        status: 200,
        body: new TextEncoder().encode(
          `${'0'.repeat(64)}  BTCUSDT-15m-2026-10-02.zip\n`,
        ),
      },
    ],
    ['not UTF-8', { status: 200, body: Uint8Array.from([0xff, 0xfe]) }],
    ['a 500', { status: 500 }],
    ['a timeout', { fail: 'timeout' as const }],
    ['a redirect', { fail: 'redirect' as const }],
  ])(
    'gives checksum_unavailable for a CHECKSUM that is %s, and never requests the zip',
    async (_, response) => {
      const http = new FakeHttp();
      http.serve(FILE, DAY_CSV);
      http.responses.set(FILE.checksumUrl, response);

      const [summary] = await loadKlines(request(), { http, sink });

      expect(summary).toMatchObject({
        status: 'checksum_unavailable',
        checksum: 'unavailable',
      });
      expect(http.urls()).toEqual([FILE.checksumUrl]);
      expectNothingOpened();
    },
  );

  it('caps the CHECKSUM and the zip downloads', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);
    await loadKlines(request(), { http, sink: new RecordingSink() });

    expect(http.requests.map(({ limits }) => limits.maxBytes)).toEqual([
      1024,
      MAX_ARCHIVE_BYTES,
    ]);
    expect(
      http.requests.every(({ limits }) => limits.timeoutMs === 60_000),
    ).toBe(true);
  });

  it('gives http_error for a zip over MAX_ARCHIVE_BYTES, and never hashes or opens it', async () => {
    const http = new FakeHttp();
    const big = new Uint8Array(MAX_ARCHIVE_BYTES + 1);
    http.responses.set(FILE.zipUrl, { status: 200, body: big });
    http.responses.set(FILE.checksumUrl, {
      status: 200,
      body: checksumBody(big, FILE.zipName),
    });

    const [summary] = await loadKlines(request(), { http, sink });

    expect(summary).toMatchObject({
      status: 'http_error',
      detail: 'too_large',
      checksum: 'not_compared',
      sha256: null,
    });
    expect(hash).not.toHaveBeenCalled();
    expectNothingOpened();
  });

  it('gives not_found for a zip 404 after a good CHECKSUM', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);
    http.responses.set(FILE.zipUrl, { status: 404 });

    const [summary] = await loadKlines(request(), { http, sink });

    expect(summary).toMatchObject({
      status: 'not_found',
      checksum: 'not_compared',
    });
    expectNothingOpened();
  });

  it.each([
    [
      'a wrong entry name',
      () => zipOf('BTCUSDT-15m-2026-10-02.csv', DAY_CSV),
      'wrong_name',
    ],
    [
      'two entries',
      () =>
        buildZip({
          entries: [
            { name: FILE.csvName, data: new TextEncoder().encode(DAY_CSV) },
            { name: 'x.csv', data: new Uint8Array(1) },
          ],
        }),
      'entry_count',
    ],
    [
      'a CSV with a NUL byte',
      () => zipOf(FILE.csvName, `${DAY_CSV}\0`),
      'nul_byte',
    ],
  ])(
    'gives archive_rejected for %s under a correct CHECKSUM, and never calls the sink',
    async (_, build, detail) => {
      const http = new FakeHttp();
      const zip = build();
      http.responses.set(FILE.zipUrl, { status: 200, body: zip });
      http.responses.set(FILE.checksumUrl, {
        status: 200,
        body: checksumBody(zip, FILE.zipName),
      });

      const [summary] = await loadKlines(request(), { http, sink });

      expect(summary).toMatchObject({
        status: 'archive_rejected',
        checksum: 'verified',
        detail,
        rows: 0,
        written: false,
      });
      expect(readSingleEntry).toHaveBeenCalledTimes(1);
      expect(sink.calls).toEqual([]);
    },
  );
});

describe('closed periods only (criterion 16)', () => {
  it('refuses a day one millisecond before its end, before any GET', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);

    await expect(
      loadKlines(request({ asOfMs: DAY_END - 1 }), {
        http,
        sink: new RecordingSink(),
      }),
    ).rejects.toThrow(RangeError);
    expect(http.requests).toEqual([]);
  });

  it('refuses a range whose last day is open, before the first GET', async () => {
    const http = new FakeHttp();

    await expect(
      loadKlines(
        request({ from: '2026-09-30', to: DAY, asOfMs: DAY_END - 1 }),
        { http, sink: new RecordingSink() },
      ),
    ).rejects.toThrow(RangeError);
    expect(http.requests).toEqual([]);
  });

  it('requests the day when asOfMs is exactly its end', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);

    const [summary] = await loadKlines(request({ asOfMs: DAY_END }), {
      http,
      sink: new RecordingSink(),
    });

    expect(http.urls()).toEqual([FILE.checksumUrl, FILE.zipUrl]);
    expect(summary).toMatchObject({ status: 'loaded', accepted: 96, open: 0 });
  });
});

/** A flat 15m bar at 60000 with a fixed range, so outliers are only what we plant. */
function flatLine(
  slot: number,
  change: Partial<Record<'high' | 'close', number>> = {},
): string {
  const cents = 6_000_000;
  return klineLine(DAY_START + slot * STEP_MS, {
    open: cents,
    high: change.high ?? cents + 50,
    low: cents - 50,
    close: change.close ?? cents,
  });
}

describe('every row accounted for (criterion 17)', () => {
  const MISSING_SLOTS = [10, 20, 30, 40, 50, 60];
  const lines: string[] = [];
  for (let slot = 0; slot < SLOTS_PER_DAY; slot += 1) {
    if (slot === 70) continue; // moved to the end: out of order
    if (!MISSING_SLOTS.includes(slot)) lines.push(flatLine(slot));
    if (slot === 10) {
      // high below close: ohlc_inconsistent
      lines.push(flatLine(10, { high: 6_000_010, close: 6_000_020 }));
    }
    if (slot === 20) lines.push(flatLine(20).replace(',10.00000000,', ',ten,'));
    if (slot === 30) {
      lines.push(flatLine(30));
      lines.push(flatLine(30, { close: 6_000_001 }));
    }
    if (slot === 40) lines.push(flatLine(40, { high: 6_500_000 }));
    if (slot === 50) lines.push('this,is,not,a,kline');
    if (slot === 80) lines.push(flatLine(80));
  }
  lines.push(flatLine(70));

  let summary: FileSummary;
  const sink = new RecordingSink();

  beforeAll(async () => {
    const http = new FakeHttp();
    http.serve(FILE, csvText(lines));
    [summary] = (await loadKlines(
      request({ outlier: { window: 4, maxRangeMultiple: 5 } }),
      { http, sink },
    )) as [FileSummary];
  });

  it('puts every row in exactly one bucket', () => {
    const quarantined = Object.values(summary.quarantined).reduce(
      (sum, count) => sum + count,
      0,
    );

    expect(summary.rows).toBe(97);
    expect(summary.accepted).toBe(90);
    expect(summary.open).toBe(0);
    expect(summary.duplicatesCollapsed).toBe(1);
    expect(summary.outOfOrder).toBe(1);
    expect(summary.quarantined).toEqual({
      malformed_row: 1,
      bad_number: 1,
      ohlc_inconsistent: 1,
      duplicate_conflict: 2,
      outlier: 1,
    });
    expect(
      summary.accepted +
        summary.open +
        quarantined +
        summary.duplicatesCollapsed,
    ).toBe(summary.rows);

    const call = sink.calls[0];
    expect(call?.candles).toHaveLength(summary.accepted);
    expect(call?.quarantine).toHaveLength(quarantined);
  });

  it('gives each quarantine record its own CSV index and original text', () => {
    const call = sink.calls[0];
    for (const record of call?.quarantine ?? []) {
      expect(record.raw).toBe(lines[record.rowIndex]);
      expect(record.sourceFile).toBe(FILE.zipName);
      expect(record.symbol).toBe('BTCUSDT');
      expect(record.timeframe).toBe('15m');
      expect(record.source).toBe('binance_vision');
    }
    const conflicts = call?.quarantine.filter(
      (record) => record.reason === 'duplicate_conflict',
    );
    expect(conflicts?.map((record) => record.rowIndex)).toHaveLength(2);
    expect(new Set(conflicts?.map((record) => record.rowIndex)).size).toBe(2);
    expect(conflicts?.map((record) => record.raw)).toEqual([
      flatLine(30),
      flatLine(30, { close: 6_000_001 }),
    ]);
    const malformed = call?.quarantine.find(
      (record) => record.reason === 'malformed_row',
    );
    expect(malformed).toMatchObject({
      raw: 'this,is,not,a,kline',
      openTimeMs: null,
    });
  });

  it('maps each candle to its own line', () => {
    for (const stored of sink.calls[0]?.candles ?? []) {
      expect(stored.line.text).toBe(lines[stored.line.index]);
      expect(Number(stored.line.fields[0]) / 1000).toBe(
        stored.candle.openTimeMs,
      );
    }
  });

  it('lists exactly the slots without an accepted candle as missing', () => {
    expect(summary.missing).toEqual(
      MISSING_SLOTS.map((slot) => ({
        fromMs: DAY_START + slot * STEP_MS,
        toMs: DAY_START + (slot + 1) * STEP_MS,
      })),
    );
  });

  it('tells two textually identical lines apart by identity', async () => {
    const twin = 'twin,row';
    const twins = [flatLine(0), twin, flatLine(1), twin, flatLine(2)];
    const http = new FakeHttp();
    const twinSink = new RecordingSink();
    http.serve(FILE, csvText(twins));

    await loadKlines(request(), { http, sink: twinSink });

    expect(
      twinSink.calls[0]?.quarantine.map(({ rowIndex, raw }) => [rowIndex, raw]),
    ).toEqual([
      [1, twin],
      [3, twin],
    ]);
  });
});

const HOSTILE = [
  "'); DROP TABLE candles; --",
  '%s %j',
  '\u001b[31m',
  '{"level":60,"msg":"x"}',
  '${process.env.X}',
  'raw-sentinel-7f3a',
];

function hostileLines(): string[] {
  const lines = walkLines(DAY_START, SLOTS_PER_DAY, 7);
  // Each hostile string replaces the volume of one row (bad_number), and is
  // also a whole line of its own (malformed_row).
  HOSTILE.forEach((text, index) => {
    const fields = (lines[index * 10] as string).split(',');
    fields[5] = text;
    lines[index * 10] = fields.join(',');
    lines.push(text);
  });
  return lines;
}

/** Fake deps for `run`: the given HTTP, and a write context with a captured pino logger. */
function runDeps(
  http: FakeHttp,
  options: { identity?: DatabaseIdentity; sink?: CandleSink } = {},
) {
  const capture = captureStream();
  const logger = pino(loggerOptions([]), capture.stream);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const closed = vi.fn(() => Promise.resolve());
  const context: BackfillContext = {
    identity: options.identity ?? {
      status: 'VERIFIED',
      marker: '6f1c2b8e-3d4a-4e5f-9a7b-1c2d3e4f5a6b',
    },
    http,
    sink: options.sink ?? new RecordingSink(),
    logger: {
      log: (message, context) => logger.info({ ...message, context }),
      warn: (message, context) => logger.warn({ ...message, context }),
      error: (message, context) => logger.error({ ...message, context }),
    },
    close: closed,
  };
  const deps = {
    clock: vi.fn(() => DAY_END + 30 * DAY_MS),
    dryRunHttp: vi.fn(() => http),
    openContext: vi.fn(() => Promise.resolve(context)),
    bootFailed: vi.fn(),
    stdout: vi.fn((text: string) => {
      stdout.push(text);
    }),
    stderr: vi.fn((text: string) => {
      stderr.push(text);
    }),
  } satisfies BackfillDeps;
  return { deps, stdout, stderr, logs: capture.lines, closed };
}

const ARGS = [
  '--symbol',
  'BTCUSDT',
  '--interval',
  '15m',
  '--period',
  'daily',
  '--outlier-window',
  '4',
  '--outlier-multiple',
  '1000',
];

function dayArgs(from: string, to: string): string[] {
  return [...ARGS, '--from', from, '--to', to];
}

describe('raw content stays out of logs and summaries (criterion 19)', () => {
  it('quarantines the hostile rows, keeps their text for the sink, and logs none of it', async () => {
    const lines = hostileLines();
    const http = new FakeHttp();
    http.serve(FILE, csvText(lines));
    const sink = new RecordingSink();
    const write = runDeps(http, { sink });

    expect(await run(dayArgs(DAY, DAY), write.deps)).toBe(0);

    const stored = sink.calls[0]?.quarantine ?? [];
    expect(stored).toHaveLength(HOSTILE.length * 2);
    for (const text of HOSTILE) {
      expect(stored.filter((record) => record.raw.includes(text))).toHaveLength(
        2,
      );
    }
    for (const record of stored)
      expect(record.raw).toBe(lines[record.rowIndex]);

    const dry = runDeps(http);
    expect(await run([...dayArgs(DAY, DAY), '--dry-run'], dry.deps)).toBe(0);

    const outputs = [
      ...write.logs,
      ...write.stdout,
      ...write.stderr,
      ...dry.logs,
      ...dry.stdout,
      ...dry.stderr,
    ];
    expect(write.logs.length).toBeGreaterThanOrEqual(2);
    expect(dry.stdout).toHaveLength(1);
    for (const output of outputs) {
      for (const text of HOSTILE) {
        expect(output).not.toContain(text);
        expect(output).not.toContain(JSON.stringify(text).slice(1, -1));
      }
    }
    const summary = JSON.parse(dry.stdout[0] as string) as FileSummary;
    // The JSON string holds commas, so its volume row splits into more fields.
    expect(summary.quarantined).toEqual({
      malformed_row: HOSTILE.length + 1,
      bad_number: HOSTILE.length - 1,
    });
  });

  it('keeps a failing sink error message out of the summary', async () => {
    const http = new FakeHttp();
    http.serve(FILE, csvText(hostileLines()));
    const sink: CandleSink = {
      storeFile: () =>
        Promise.reject(
          Object.assign(new Error(`failed on ${HOSTILE.join(' ')}`), {
            code: '23514',
          }),
        ),
    };
    const write = runDeps(http, { sink });

    expect(await run(dayArgs(DAY, DAY), write.deps)).toBe(1);
    const lines = write.logs.join('\n');
    expect(lines).toContain('store_error');
    expect(lines).toContain('sqlstate_23514');
    for (const text of HOSTILE) expect(lines).not.toContain(text);
  });
});

describe('exit status (criterion 20)', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const files = days.map((day) => bulkFile('BTCUSDT', '15m', 'daily', day));

  function serveAll(http: FakeHttp, skip?: number): void {
    files.forEach((file, index) => {
      if (index === skip) return;
      http.serve(
        file,
        csvText(walkLines(file.range.fromMs, SLOTS_PER_DAY, index + 1)),
      );
    });
  }

  it('processes all three files when one is not_found, and returns 1', async () => {
    const http = new FakeHttp();
    serveAll(http, 1);
    const write = runDeps(http);

    expect(
      await run(dayArgs(days[0] as string, days[2] as string), write.deps),
    ).toBe(1);
    const statuses = write.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'Backfill file')
      .map((line) => [line.file, line.status]);
    expect(statuses).toEqual([
      [files[0]?.zipName, 'loaded'],
      [files[1]?.zipName, 'not_found'],
      [files[2]?.zipName, 'loaded'],
    ]);
    expect(http.urls()).toContain(files[2]?.zipUrl);
    expect(write.closed).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when every file loaded', async () => {
    const http = new FakeHttp();
    serveAll(http);
    const write = runDeps(http);

    expect(
      await run(dayArgs(days[0] as string, days[2] as string), write.deps),
    ).toBe(0);
    expect(write.deps.dryRunHttp).not.toHaveBeenCalled();
  });

  it('in a dry run never opens the context, needs no environment, and prints one JSON line per file', async () => {
    const http = new FakeHttp();
    serveAll(http);
    const dry = runDeps(http);
    const saved = process.env;
    process.env = {};
    let code: number;
    try {
      code = await run(
        [...dayArgs(days[0] as string, days[2] as string), '--dry-run'],
        dry.deps,
      );
    } finally {
      process.env = saved;
    }

    expect(code).toBe(0);
    expect(dry.deps.openContext).not.toHaveBeenCalled();
    expect(dry.logs).toEqual([]);
    expect(dry.stderr).toEqual([]);
    expect(dry.stdout).toHaveLength(3);
    for (const [index, text] of dry.stdout.entries()) {
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toMatchObject({
        file: files[index]?.zipName,
        status: 'loaded',
        written: false,
        inserted: 0,
      });
    }
  });

  it('a dry run with a failed file returns 1', async () => {
    const http = new FakeHttp();
    serveAll(http, 0);
    const dry = runDeps(http);

    expect(
      await run(
        [...dayArgs(days[0] as string, days[2] as string), '--dry-run'],
        dry.deps,
      ),
    ).toBe(1);
    expect(dry.stdout).toHaveLength(3);
  });

  it('a write run on an UNKNOWN identity logs the identity line, makes no request, writes nothing, and returns 1', async () => {
    const http = new FakeHttp();
    serveAll(http);
    const sink = new RecordingSink();
    const write = runDeps(http, {
      identity: { status: 'UNKNOWN', reason: 'not_configured' },
      sink,
    });

    expect(
      await run(dayArgs(days[0] as string, days[0] as string), write.deps),
    ).toBe(1);
    expect(http.requests).toEqual([]);
    expect(sink.calls).toEqual([]);
    const lines = write.logs.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'Database identity',
      status: 'UNKNOWN',
      reason: 'not_configured',
    });
    expect(write.closed).toHaveBeenCalledTimes(1);
  });

  it('a failed boot is printed through bootFailed and returns 1', async () => {
    const http = new FakeHttp();
    const write = runDeps(http);
    const failure = new Error('boot failed');
    write.deps.openContext.mockRejectedValueOnce(failure);

    expect(
      await run(dayArgs(days[0] as string, days[0] as string), write.deps),
    ).toBe(1);
    expect(write.deps.bootFailed).toHaveBeenCalledWith(failure);
    expect(http.requests).toEqual([]);
  });
});

describe('summaries are plain data', () => {
  it('has the field set of the real-file check, and survives JSON', async () => {
    const http = new FakeHttp();
    http.serve(FILE, DAY_CSV);
    const [summary] = await loadKlines(request({ dryRun: true }), {
      http,
      sink: null,
    });

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(Object.keys(summary as object).sort()).toEqual(
      [
        'file',
        'status',
        'detail',
        'checksum',
        'sha256',
        'header',
        'rows',
        'accepted',
        'open',
        'quarantined',
        'missing',
        'unjudged',
        'duplicatesCollapsed',
        'outOfOrder',
        'timeUnits',
        'firstOpenTimeMs',
        'lastOpenTimeMs',
        'lastCloseTimeMs',
        'written',
        'inserted',
        'alreadyStored',
        'storedConflicts',
        'outlier',
      ].sort(),
    );
    expect(summary).toMatchObject({ written: false, inserted: 0 });
  });
});
