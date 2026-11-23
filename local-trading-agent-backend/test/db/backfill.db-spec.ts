import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { Client } from 'pg';
import { symbols } from 'pino';
import {
  backfillContext,
  productionDeps,
  run,
  type BackfillDeps,
} from '../../src/backfill.js';
import { BackfillModule } from '../../src/backfill.module.js';
import { bulkFile } from '../../src/market-data/binance-vision.js';
import { HTTP_GET } from '../../src/market-data/market-data.module.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  markerRows,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
  withClient,
} from '../fixtures/db.js';
import { captureStream } from '../fixtures/logs.js';
import { closedPort } from '../fixtures/main.js';
import {
  DAY_FIXTURE,
  DAY_MS,
  FakeHttp,
  readFixture,
} from '../fixtures/market-data/bulk.js';

// S1b criterion 25: the identity guard on the write path. BackfillModule boots
// on a migrated throwaway database with HTTP_GET replaced by the fake, so no
// request leaves the machine.

const DAY = '2026-10-01';
const FILE = bulkFile('BTCUSDT', '15m', 'daily', DAY);
const ARGS = [
  '--symbol',
  'BTCUSDT',
  '--interval',
  '15m',
  '--period',
  'daily',
  '--from',
  DAY,
  '--to',
  DAY,
  '--outlier-window',
  '4',
  '--outlier-multiple',
  '1000',
];

let admin: Client;
const database = newTestDatabaseName();
let marker: string;

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  await createTestDatabase(admin, database);
  const result = await runDbMigrate(testDatabaseUrl(database));
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
  const [row] = await markerRows(database);
  marker = row?.marker as string;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await dropTestDatabase(admin, database);
  await admin.end();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Counts {
  assets: number;
  candles: number;
  quarantine: number;
}

function counts(): Promise<Counts> {
  return withClient(testDatabaseUrl(database), async (client) => {
    const read = async (table: string): Promise<number> =>
      Number(
        (
          await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM ${table}`,
          )
        ).rows[0]?.n,
      );
    return {
      assets: await read('assets'),
      candles: await read('candles'),
      quarantine: await read('market_data_quarantine'),
    };
  });
}

/** Deps that boot BackfillModule with the fake HTTP and a captured logger. */
function testDeps(http: FakeHttp) {
  const capture = captureStream();
  const deps: BackfillDeps = {
    clock: () => Date.UTC(2026, 9, 1) + 30 * DAY_MS,
    dryRunHttp: () => {
      throw new Error('not a dry run');
    },
    openContext: async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BackfillModule],
      })
        .overrideProvider(HTTP_GET)
        .useValue(http)
        .compile();
      const root = PinoLogger.root as unknown as Record<symbol, unknown>;
      root[symbols.streamSym] = capture.stream;
      return backfillContext(moduleRef);
    },
    bootFailed: (error) => {
      throw error;
    },
    stdout: () => undefined,
    stderr: () => undefined,
  };
  return { deps, lines: capture.lines };
}

function stubEnv(identity: string | undefined): void {
  vi.stubEnv('DATABASE_URL', testDatabaseUrl(database));
  vi.stubEnv('TRADER_MODE', 'paper');
  vi.stubEnv('DATABASE_IDENTITY', identity);
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
}

describe('the write path needs a VERIFIED identity (criterion 25)', () => {
  it.each([
    ['unset', undefined, 'not_configured'],
    ['wrong', '00000000-0000-4000-8000-000000000000', 'mismatch'],
  ])(
    'with DATABASE_IDENTITY %s, writes no row, logs the identity line, and exits 1',
    async (_, identity, reason) => {
      stubEnv(identity);
      const http = new FakeHttp();
      http.serve(FILE, readFixture(DAY_FIXTURE));
      const { deps, lines } = testDeps(http);

      expect(await run(ARGS, deps)).toBe(1);
      expect(http.requests).toEqual([]);
      expect(await counts()).toEqual({ assets: 0, candles: 0, quarantine: 0 });
      const parsed = lines.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      expect(parsed).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: 'Database identity',
          status: 'UNKNOWN',
          reason,
        }),
      );
    },
  );

  it('with DATABASE_IDENTITY equal to the stored marker, writes the fixture day', async () => {
    stubEnv(marker);
    const http = new FakeHttp();
    http.serve(FILE, readFixture(DAY_FIXTURE));
    const { deps, lines } = testDeps(http);

    expect(await run(ARGS, deps)).toBe(0);
    expect(await counts()).toEqual({ assets: 1, candles: 96, quarantine: 0 });
    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(parsed).toContainEqual(
      expect.objectContaining({
        msg: 'Database identity',
        status: 'VERIFIED',
        marker,
      }),
    );
    expect(parsed).toContainEqual(
      expect.objectContaining({
        msg: 'Backfill file',
        file: FILE.zipName,
        status: 'loaded',
        inserted: 96,
      }),
    );
  });
});

describe('the dry run never connects (criterion 25)', () => {
  it('succeeds with DATABASE_URL pointing at a closed port', async () => {
    const port = await closedPort();
    vi.stubEnv(
      'DATABASE_URL',
      `postgresql://trader:local-dev-only@127.0.0.1:${port}/trader`,
    );
    vi.stubEnv('TRADER_MODE', 'paper');
    const http = new FakeHttp();
    http.serve(FILE, readFixture(DAY_FIXTURE));
    const stdout: string[] = [];
    const openContext = vi.fn(productionDeps.openContext);

    const code = await run([...ARGS, '--dry-run'], {
      ...productionDeps,
      clock: () => Date.UTC(2026, 9, 1) + 30 * DAY_MS,
      dryRunHttp: () => http,
      openContext,
      stdout: (text) => {
        stdout.push(text);
      },
    });

    expect(code).toBe(0);
    expect(openContext).not.toHaveBeenCalled();
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({
      status: 'loaded',
      written: false,
    });
  });
});
