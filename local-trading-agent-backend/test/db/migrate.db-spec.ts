import { createServer, type AddressInfo } from 'node:net';
import { Client } from 'pg';
import { z } from 'zod';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
  userObjects,
  withClient,
  withTestDatabase,
  type RunResult,
} from '../fixtures/db.js';
import { readAppFile } from '../fixtures/repo.js';

// Runs against the compose Postgres from `make db-up`. Every database here is
// a throwaway `trader_test_*` one, created and dropped through the guarded
// helpers in test/fixtures/db.ts.

const WRONG_PASSWORD = 'wrong-password-sentinel-3c9e';

/** The migrations the committed journal lists. */
const JOURNAL_ENTRIES = z
  .object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(JSON.parse(readAppFile('src/db/migrations/meta/_journal.json')))
  .entries.length;

/**
 * Everything outside `drizzle` after all migrations: the marker table and the
 * S1b market-data tables, with what Postgres makes for each (row type, array
 * type, primary-key index, and the unique index on `assets`). Nothing else.
 */
const MIGRATED_OBJECTS = [
  { schema: 'public', name: '_assets', kind: 'type' },
  { schema: 'public', name: '_candles', kind: 'type' },
  { schema: 'public', name: '_database_identity', kind: 'type' },
  { schema: 'public', name: '_market_data_quarantine', kind: 'type' },
  { schema: 'public', name: 'assets', kind: 'relation r' },
  { schema: 'public', name: 'assets', kind: 'type' },
  {
    schema: 'public',
    name: 'assets_exchange_market_type_symbol',
    kind: 'relation i',
  },
  { schema: 'public', name: 'assets_pkey', kind: 'relation i' },
  { schema: 'public', name: 'candles', kind: 'relation r' },
  { schema: 'public', name: 'candles', kind: 'type' },
  { schema: 'public', name: 'candles_pkey', kind: 'relation i' },
  { schema: 'public', name: 'database_identity', kind: 'relation r' },
  { schema: 'public', name: 'database_identity', kind: 'type' },
  { schema: 'public', name: 'database_identity_pkey', kind: 'relation i' },
  { schema: 'public', name: 'market_data_quarantine', kind: 'relation r' },
  { schema: 'public', name: 'market_data_quarantine', kind: 'type' },
  { schema: 'public', name: 'market_data_quarantine_pkey', kind: 'relation i' },
];

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

interface MigrationRow {
  hash: string;
  created_at: string;
}

function migrationRows(database: string): Promise<MigrationRow[]> {
  return withClient(testDatabaseUrl(database), async (client) => {
    const result = await client.query<MigrationRow>(
      'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    return result.rows;
  });
}

async function databaseExists(name: string): Promise<boolean> {
  const result = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  return result.rowCount === 1;
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function output(result: RunResult): string {
  return result.stdout + result.stderr;
}

describe('pnpm db:migrate on a throwaway database', () => {
  const database = newTestDatabaseName();
  let first: RunResult;

  beforeAll(async () => {
    await createTestDatabase(admin, database);
    first = await runDbMigrate(composeUrl(database));
  });

  afterAll(async () => {
    await dropTestDatabase(admin, database);
    expect(await databaseExists(database)).toBe(false);
  });

  it('exits 0', () => {
    expect(first.timedOut).toBe(false);
    expect(first.code, output(first)).toBe(0);
  });

  it("records one row per journal entry in drizzle's migrations table", async () => {
    expect(await migrationRows(database)).toHaveLength(JOURNAL_ENTRIES);
  });

  it('creates nothing outside drizzle but the marker and market-data tables and what Postgres makes for them', async () => {
    expect(await userObjects(database, ['drizzle'])).toEqual(MIGRATED_OBJECTS);
  });

  it("the inventory does see drizzle's own table", async () => {
    expect(await userObjects(database, [])).toContainEqual({
      schema: 'drizzle',
      name: '__drizzle_migrations',
      kind: 'relation r',
    });
  });

  it('prints neither the URL nor its password', () => {
    const url = new URL(composeUrl(database));

    expect(output(first)).not.toContain(url.toString());
    expect(output(first)).not.toContain(decodeURIComponent(url.password));
  });

  it('a second run exits 0 and changes nothing', async () => {
    const before = await migrationRows(database);
    const objectsBefore = await userObjects(database, []);

    const second = await runDbMigrate(composeUrl(database));

    expect(second.code, output(second)).toBe(0);
    expect(await migrationRows(database)).toEqual(before);
    expect(before).toHaveLength(JOURNAL_ENTRIES);
    expect(await userObjects(database, [])).toEqual(objectsBefore);
  });
});

describe('withTestDatabase against the server', () => {
  it('drops the database even when the body throws', async () => {
    let seen = '';

    await expect(
      withTestDatabase(admin, async (name) => {
        seen = name;
        expect(await databaseExists(name)).toBe(true);
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');
    expect(seen).not.toBe('');
    expect(await databaseExists(seen)).toBe(false);
  });
});

describe('pnpm db:migrate failures', () => {
  function expectFailure(result: RunResult): void {
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBeNull();
    expect(output(result)).not.toContain(WRONG_PASSWORD);
  }

  it('exits non-zero when DATABASE_URL is unset', async () => {
    expectFailure(await runDbMigrate(undefined));
  });

  it('exits non-zero on a wrong password, applies nothing, and hides it', async () => {
    await withTestDatabase(admin, async (name) => {
      const url = new URL(composeUrl(name));
      url.password = WRONG_PASSWORD;

      expectFailure(await runDbMigrate(url.toString()));
      expect(await userObjects(name, [])).toEqual([]);
    });
  });

  it('exits non-zero when no server listens on the port, and hides the password', async () => {
    const url = new URL(composeUrl(newTestDatabaseName()));
    url.password = WRONG_PASSWORD;
    url.port = String(await closedPort());

    expectFailure(await runDbMigrate(url.toString()));
  });
});
