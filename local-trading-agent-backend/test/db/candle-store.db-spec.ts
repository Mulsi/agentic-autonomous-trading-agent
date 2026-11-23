import { asc, count, eq } from 'drizzle-orm';
import { Client, DatabaseError } from 'pg';
import {
  connectDatabase,
  type DatabaseConnection,
} from '../../src/db/client.js';
import { assets, candles, marketDataQuarantine } from '../../src/db/schema.js';
import { bulkFile } from '../../src/market-data/binance-vision.js';
import {
  loadKlines,
  type FileSummary,
  type LoadRequest,
} from '../../src/market-data/bulk-loader.js';
import { DrizzleCandleSink } from '../../src/market-data/candle-store.js';
import { parseNonNegativeDecimal } from '../../src/shared/decimal.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
  withClient,
} from '../fixtures/db.js';
import {
  csvText,
  DAY_FIXTURE,
  DAY_MS,
  FakeHttp,
  klineLine,
  readFixture,
  SLOTS_PER_DAY,
  STEP_MS,
} from '../fixtures/market-data/bulk.js';

// S1b criteria 21, 22, 23 and the SQL half of 29, against the compose Postgres
// from `make db-up`. Every database is a throwaway `trader_test_*` one,
// migrated with `pnpm db:migrate`.

const CHECK_VIOLATION = '23514';
const DAY = '2026-10-01';
const DAY_START = Date.UTC(2026, 9, 1);
const FILE = bulkFile('BTCUSDT', '15m', 'daily', DAY);
const DAY_CSV = readFixture(DAY_FIXTURE);

const HOSTILE = [
  "'); DROP TABLE candles; --",
  '%s %j',
  '\u001b[31m',
  '{"level":60,"msg":"x"}',
  '${process.env.X}',
  'raw-sentinel-7f3a',
];

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

interface Migrated {
  name: string;
  connection: DatabaseConnection;
}

async function migratedDatabase(): Promise<Migrated> {
  const name = newTestDatabaseName();
  await createTestDatabase(admin, name);
  const result = await runDbMigrate(testDatabaseUrl(name));
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
  const connection = await connectDatabase({
    DATABASE_URL: testDatabaseUrl(name),
    TRADER_MODE: 'paper',
  });
  return { name, connection };
}

async function dropMigrated(database: Migrated | undefined): Promise<void> {
  if (database === undefined) return;
  await database.connection.close();
  await dropTestDatabase(admin, database.name);
}

function request(overrides: Partial<LoadRequest> = {}): LoadRequest {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    period: 'daily',
    from: DAY,
    to: DAY,
    asOfMs: DAY_START + 60 * DAY_MS,
    outlier: { window: 4, maxRangeMultiple: 1000 },
    dryRun: false,
    ...overrides,
  };
}

async function load(
  database: Migrated,
  http: FakeHttp,
  overrides: Partial<LoadRequest> = {},
  sink = new DrizzleCandleSink(database.connection.db),
): Promise<FileSummary[]> {
  return loadKlines(request(overrides), { http, sink });
}

/** A flat bar: open = close = 60000, range ±0.50, so nothing is an outlier. */
function flatLine(slot: number, close = '60000.00000000'): string {
  const line = klineLine(DAY_START + slot * STEP_MS, {
    open: 6_000_000,
    high: 6_000_050,
    low: 5_999_950,
    close: 6_000_000,
  });
  const fields = line.split(',');
  fields[4] = close;
  return fields.join(',');
}

function flatDay(): string[] {
  return Array.from({ length: SLOTS_PER_DAY }, (_, slot) => flatLine(slot));
}

const MONEY = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'quoteVolume',
  'takerBuyBaseVolume',
  'takerBuyQuoteVolume',
] as const;

/** The 12 fixture fields of each line, keyed by open time in ms. */
function fixtureByTime(text: string): Map<number, string[]> {
  return new Map(
    text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const fields = line.split(',');
        return [Number(fields[0]) / 1000, fields];
      }),
  );
}

describe('round trip and data safety (criterion 21)', () => {
  let database: Migrated | undefined;
  let summary: FileSummary;
  const originalTz = process.env.TZ;

  beforeAll(async () => {
    database = await migratedDatabase();
    const lines = DAY_CSV.split('\n').filter((line) => line !== '');
    // The hostile strings ride along as whole lines, each quarantined.
    const http = new FakeHttp();
    http.serve(FILE, csvText([...lines, ...HOSTILE]));
    [summary] = (await load(database, http)) as [FileSummary];
  });

  afterAll(async () => {
    process.env.TZ = originalTz;
    await dropMigrated(database);
  });

  it('stores the 96 candles', () => {
    expect(summary).toMatchObject({
      status: 'loaded',
      accepted: 96,
      inserted: 96,
      quarantined: { malformed_row: HOSTILE.length },
    });
  });

  it.each(['UTC', 'Europe/Ljubljana'])(
    'reads every column back exactly under TZ=%s',
    async (tz) => {
      process.env.TZ = tz;
      const rows = await database!.connection.db
        .select()
        .from(candles)
        .orderBy(asc(candles.openTimeMs));
      const input = fixtureByTime(DAY_CSV);

      expect(rows).toHaveLength(96);
      for (const row of rows) {
        const fields = input.get(row.openTimeMs) as string[];
        expect(fields).toBeDefined();
        expect(row.closeTimeMs).toBe(
          (Number(fields[6]) - (Number(fields[6]) % 1000)) / 1000,
        );
        expect(row.tradeCount).toBe(BigInt(fields[8] as string));
        expect(typeof row.tradeCount).toBe('bigint');
        expect(row.isClosed).toBe(true);
        expect(row.source).toBe('binance_vision');
        expect(row.timeframe).toBe('15m');
        const inputs = [1, 2, 3, 4, 5, 7, 9, 10].map((index) =>
          parseNonNegativeDecimal(fields[index]),
        );
        MONEY.forEach((column, index) => {
          expect(typeof row[column]).toBe('string');
          expect(inputs[index]?.eq(row[column])).toBe(true);
        });
      }
      expect(rows[0]?.openTimeMs).toBe(1790812800000);
      expect(rows.at(-1)?.closeTimeMs).toBe(1790899199999);
    },
  );

  it('stores every hostile line as data, byte-equal, and leaves candles intact', async () => {
    const db = database!.connection.db;
    const rows = await db
      .select()
      .from(marketDataQuarantine)
      .orderBy(asc(marketDataQuarantine.rowIndex));

    expect(rows.map((row) => row.raw)).toEqual(HOSTILE);
    expect(rows.map((row) => row.rowIndex)).toEqual(
      HOSTILE.map((_, index) => 96 + index),
    );
    for (const row of rows) {
      expect(row.reason).toBe('malformed_row');
      expect(row.sourceFile).toBe(FILE.zipName);
      expect(row.openTimeMs).toBeNull();
    }
    const [total] = await db.select({ n: count() }).from(candles);
    expect(total?.n).toBe(96);
  });
});

describe('idempotent (criterion 22)', () => {
  let database: Migrated | undefined;

  beforeAll(async () => {
    database = await migratedDatabase();
  });

  afterAll(async () => {
    await dropMigrated(database);
  });

  it('a second load of the same file changes nothing', async () => {
    const db = database!.connection.db;
    const http = new FakeHttp();
    http.serve(
      FILE,
      csvText([...DAY_CSV.split('\n').filter(Boolean), 'bad,row']),
    );

    const [first] = await load(database!, http);
    const candlesBefore = await db
      .select()
      .from(candles)
      .orderBy(asc(candles.openTimeMs));
    const quarantineBefore = await db.select().from(marketDataQuarantine);
    const [second] = await load(database!, http);

    expect(first).toMatchObject({
      inserted: 96,
      alreadyStored: 0,
      storedConflicts: 0,
    });
    expect(second).toMatchObject({
      status: 'loaded',
      inserted: 0,
      alreadyStored: 96,
      storedConflicts: 0,
    });
    expect(
      await db.select().from(candles).orderBy(asc(candles.openTimeMs)),
    ).toEqual(candlesBefore);
    expect(await db.select().from(marketDataQuarantine)).toEqual(
      quarantineBefore,
    );
    expect(quarantineBefore).toHaveLength(1);
    expect(candlesBefore[0]?.ingestedAt).toBeInstanceOf(Date);
    expect(await db.select().from(assets)).toEqual([
      expect.objectContaining({
        exchange: 'binance',
        marketType: 'spot',
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      }),
    ]);
  });

  it('loads a monthly 15m file of 2,976 rows in one transaction', async () => {
    const db = database!.connection.db;
    const month = bulkFile('ETHUSDT', '15m', 'monthly', '2026-10');
    const lines = Array.from({ length: 31 * SLOTS_PER_DAY }, (_, slot) =>
      klineLine(month.range.fromMs + slot * STEP_MS, {
        open: 300_000,
        high: 300_050,
        low: 299_950,
        close: 300_000,
      }),
    );
    const http = new FakeHttp();
    http.serve(month, csvText(lines));

    const [summary] = await loadKlines(
      request({
        symbol: 'ETHUSDT',
        period: 'monthly',
        from: '2026-10',
        to: '2026-10',
      }),
      { http, sink: new DrizzleCandleSink(db) },
    );

    expect(lines).toHaveLength(2976);
    expect(summary).toMatchObject({
      status: 'loaded',
      rows: 2976,
      inserted: 2976,
    });
    const [eth] = await db
      .select()
      .from(assets)
      .where(eq(assets.symbol, 'ETHUSDT'));
    const [stored] = await db
      .select({ n: count() })
      .from(candles)
      .where(eq(candles.assetId, eth?.id as string));
    expect(stored?.n).toBe(2976);
  });
});

describe('conflict and rollback (criterion 23)', () => {
  let database: Migrated | undefined;

  beforeAll(async () => {
    database = await migratedDatabase();
  });

  afterAll(async () => {
    await dropMigrated(database);
  });

  it('quarantines a close that differs in the 18th significant digit, and keeps the stored row', async () => {
    const db = database!.connection.db;
    const first = new FakeHttp();
    first.serve(FILE, csvText(flatDay()));
    await load(database!, first);
    const before = await db
      .select()
      .from(candles)
      .orderBy(asc(candles.openTimeMs));

    const changed = flatDay();
    const conflicting = flatLine(10, '59999.9999999999999');
    expect(
      conflicting.split(',')[4]?.replace('.', '').replace(/^0+/, ''),
    ).toHaveLength(18);
    changed[10] = conflicting;
    const second = new FakeHttp();
    second.serve(FILE, csvText(changed));
    const [summary] = await load(database!, second);

    expect(summary).toMatchObject({
      status: 'loaded',
      inserted: 0,
      alreadyStored: 95,
      storedConflicts: 1,
    });
    expect(
      await db.select().from(candles).orderBy(asc(candles.openTimeMs)),
    ).toEqual(before);
    // Stored as Decimal.toFixed() of the parsed value: equal by value, not by
    // the source's trailing zeros.
    expect(before[10]?.close).toBe('60000');
    const quarantine = await db.select().from(marketDataQuarantine);
    expect(quarantine).toEqual([
      expect.objectContaining({
        reason: 'stored_conflict',
        rowIndex: 10,
        raw: conflicting,
        openTimeMs: DAY_START + 10 * STEP_MS,
        sourceFile: FILE.zipName,
      }),
    ]);
  });

  it('keeps outlier_checked false after a later run judges the bar', async () => {
    const db = database!.connection.db;
    const sinkDb = new DrizzleCandleSink(db);
    const day2 = bulkFile('SOLUSDT', '15m', 'daily', '2026-10-02');
    const day1 = bulkFile('SOLUSDT', '15m', 'daily', '2026-10-01');
    const lines = (file: typeof day1): string[] =>
      Array.from({ length: SLOTS_PER_DAY }, (_, slot) =>
        klineLine(file.range.fromMs + slot * STEP_MS, {
          open: 15_000,
          high: 15_010,
          low: 14_990,
          close: 15_000,
        }),
      );
    const http = new FakeHttp();
    http.serve(day1, csvText(lines(day1)));
    http.serve(day2, csvText(lines(day2)));
    const base = { symbol: 'SOLUSDT' };

    // Run 1: day 2 alone; its first five bars are unjudged.
    const [alone] = await loadKlines(
      request({ ...base, from: '2026-10-02', to: '2026-10-02' }),
      { http, sink: sinkDb },
    );
    // Run 2: days 1 and 2; day 1 is history, so day 2 is judged in full.
    const [, chained] = await loadKlines(
      request({ ...base, from: '2026-10-01', to: '2026-10-02' }),
      { http, sink: sinkDb },
    );

    expect(alone?.unjudged).toBe(5);
    expect(chained).toMatchObject({
      unjudged: 0,
      alreadyStored: 96,
      storedConflicts: 0,
    });
    const [sol] = await db
      .select()
      .from(assets)
      .where(eq(assets.symbol, 'SOLUSDT'));
    const stored = await db
      .select({ time: candles.openTimeMs, checked: candles.outlierChecked })
      .from(candles)
      .where(eq(candles.assetId, sol?.id as string))
      .orderBy(asc(candles.openTimeMs));
    const day2Rows = stored.filter(({ time }) => time >= day2.range.fromMs);
    expect(day2Rows.slice(0, 5).map(({ checked }) => checked)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(day2Rows.slice(5).every(({ checked }) => checked)).toBe(true);
  });

  it('rolls the whole file back when the quarantine insert fails', async () => {
    const failing = await migratedDatabase();
    try {
      const db = failing.connection.db;
      class FailingSink extends DrizzleCandleSink {
        protected override insertQuarantine(): Promise<void> {
          return Promise.reject(
            new Error('forced failure after the candle insert'),
          );
        }
      }
      const http = new FakeHttp();
      http.serve(FILE, csvText([...flatDay(), 'bad,row']));
      const insertCandles = vi.spyOn(
        DrizzleCandleSink.prototype as unknown as {
          insertCandles: () => unknown;
        },
        'insertCandles',
      );

      const [summary] = await load(failing, http, {}, new FailingSink(db));

      expect(insertCandles).toHaveBeenCalledTimes(1);
      insertCandles.mockRestore();
      expect(summary).toMatchObject({ status: 'store_error', written: false });
      expect(await db.select().from(candles)).toEqual([]);
      expect(await db.select().from(marketDataQuarantine)).toEqual([]);
      expect(await db.select().from(assets)).toEqual([]);
    } finally {
      await dropMigrated(failing);
    }
  });
});

describe('the SQL checks (criterion 29)', () => {
  let database: Migrated | undefined;

  beforeAll(async () => {
    database = await migratedDatabase();
  });

  afterAll(async () => {
    await dropMigrated(database);
  });

  async function sqlstate(sql: string): Promise<string | undefined> {
    return withClient(testDatabaseUrl(database!.name), async (client) => {
      try {
        await client.query(sql);
        return undefined;
      } catch (error) {
        return error instanceof DatabaseError ? error.code : String(error);
      }
    });
  }

  it('refuses a quarantine row with reason bogus', async () => {
    expect(
      await sqlstate(
        "INSERT INTO market_data_quarantine (source, source_file, row_index, symbol, timeframe, reason, raw) VALUES ('x', 'f', 0, 'BTCUSDT', '15m', 'bogus', 'x')",
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a candle with timeframe 5m', async () => {
    const asset = await sqlstate(
      "INSERT INTO assets (exchange, market_type, symbol, base_asset, quote_asset) VALUES ('binance', 'spot', 'BTCUSDT', 'BTC', 'USDT')",
    );
    expect(asset).toBeUndefined();
    expect(
      await sqlstate(
        "INSERT INTO candles (asset_id, timeframe, open_time_ms, close_time_ms, open, high, low, close, volume, quote_volume, taker_buy_base_volume, taker_buy_quote_volume, trade_count, is_closed, outlier_checked, source) SELECT id, '5m', 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, true, true, 'x' FROM assets",
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('control: a valid reason and timeframe are accepted', async () => {
    expect(
      await sqlstate(
        "INSERT INTO market_data_quarantine (source, source_file, row_index, symbol, timeframe, reason, raw) VALUES ('x', 'f', 0, 'BTCUSDT', '15m', 'stored_conflict', 'x')",
      ),
    ).toBeUndefined();
  });
});
