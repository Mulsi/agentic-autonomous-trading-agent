import { Client, DatabaseError } from 'pg';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
  withClient,
} from '../fixtures/db.js';
import { readRepoFile } from '../fixtures/repo.js';

// research_reader on the compose Postgres from `make db-up`. Roles belong to
// the whole server, so the migrations create it on this server; the databases
// here are throwaway `trader_test_*` ones.

const ROLE = 'research_reader';
const INSUFFICIENT_PRIVILEGE = '42501';

/** The research URL as research/README.md documents it. */
function documentedUrl(): URL {
  const match =
    /postgresql:\/\/research_reader:([^@\s`]+)@127\.0\.0\.1:55432\/trader/.exec(
      readRepoFile('research/README.md'),
    );
  if (!match) throw new Error('research/README.md: no research_reader URL');
  return new URL(match[0]);
}

/** The documented credentials, pointed at a throwaway database. */
function researchUrl(database: string): string {
  const documented = documentedUrl();
  const url = new URL(testDatabaseUrl(database));
  url.username = documented.username;
  url.password = documented.password;
  return url.toString();
}

let admin: Client;
const first = newTestDatabaseName();
const second = newTestDatabaseName();

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  await createTestDatabase(admin, first);
  const result = await runDbMigrate(testDatabaseUrl(first));
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
});

afterAll(async () => {
  await dropTestDatabase(admin, first);
  await dropTestDatabase(admin, second);
  await admin.end();
});

/** Runs `sql` in its own `BEGIN READ WRITE`, rolls back, returns the SQLSTATE. */
async function attempt(
  client: Client,
  sql: string,
): Promise<string | undefined> {
  await client.query('BEGIN READ WRITE');
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return error instanceof DatabaseError ? error.code : String(error);
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('research_reader, the role', () => {
  interface RoleRow {
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }

  it('exists, can log in, and has no other attribute', async () => {
    const result = await admin.query<RoleRow>(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
      [ROLE],
    );

    expect(result.rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
  });

  it('is a member of no role', async () => {
    const result = await admin.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [ROLE],
    );

    expect(result.rowCount).toBe(0);
  });

  it('migrating a second database, with the role already present, succeeds', async () => {
    await createTestDatabase(admin, second);

    const result = await runDbMigrate(testDatabaseUrl(second));

    expect(result.code, result.stderr).toBe(0);
    await withClient(researchUrl(second), async (client) => {
      const rows = await client.query('SELECT marker FROM database_identity');
      expect(rows.rowCount).toBe(1);
    });
  });
});

describe('connected as research_reader with its documented password', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: researchUrl(first) });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('is connected as research_reader, in read-only sessions by default', async () => {
    const result = await client.query<{ user: string; ro: string }>(
      'SELECT current_user AS user, current_setting($1) AS ro',
      ['default_transaction_read_only'],
    );

    expect(result.rows).toEqual([{ user: ROLE, ro: 'on' }]);
  });

  it('control: BEGIN READ WRITE really opens a read-write transaction', async () => {
    await client.query('BEGIN READ WRITE');
    try {
      const result = await client.query<{ transaction_read_only: string }>(
        'SHOW transaction_read_only',
      );
      expect(result.rows[0]?.transaction_read_only).toBe('off');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('can read the marker table', async () => {
    expect(await attempt(client, 'SELECT marker FROM database_identity')).toBe(
      undefined,
    );
  });

  it.each([
    [
      'INSERT on the marker table',
      'INSERT INTO database_identity (singleton, marker) VALUES (true, gen_random_uuid())',
    ],
    [
      'UPDATE on the marker table',
      'UPDATE database_identity SET marker = gen_random_uuid()',
    ],
    ['DELETE on the marker table', 'DELETE FROM database_identity'],
    ['TRUNCATE on the marker table', 'TRUNCATE database_identity'],
    [
      'INSERT on the migrations table',
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('x', 0)",
    ],
    [
      'UPDATE on the migrations table',
      "UPDATE drizzle.__drizzle_migrations SET hash = 'x'",
    ],
    [
      'DELETE on the migrations table',
      'DELETE FROM drizzle.__drizzle_migrations',
    ],
    [
      'TRUNCATE on the migrations table',
      'TRUNCATE drizzle.__drizzle_migrations',
    ],
    ['CREATE TABLE in public', 'CREATE TABLE public.research_scratch (id int)'],
    [
      'CREATE TABLE in drizzle',
      'CREATE TABLE drizzle.research_scratch (id int)',
    ],
    [
      'ALTER TABLE on the marker table',
      'ALTER TABLE database_identity ADD COLUMN note text',
    ],
    ['DROP TABLE on the marker table', 'DROP TABLE database_identity'],
    ['CREATE ROLE', 'CREATE ROLE research_scratch'],
  ])('%s fails with 42501', async (_, sql) => {
    expect(await attempt(client, sql)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // S1b criterion 26: the market-data tables, through the default privileges
  // from migration 0003, with no new grant.
  it.each(['assets', 'candles', 'market_data_quarantine'])(
    'can read %s',
    async (table) => {
      expect(await attempt(client, `SELECT * FROM ${table} LIMIT 1`)).toBe(
        undefined,
      );
    },
  );

  it.each([
    [
      'assets',
      "INSERT INTO assets (exchange, market_type, symbol, base_asset, quote_asset) VALUES ('binance', 'spot', 'BTCUSDT', 'BTC', 'USDT')",
    ],
    [
      'candles',
      "INSERT INTO candles (asset_id, timeframe, open_time_ms, close_time_ms, open, high, low, close, volume, quote_volume, taker_buy_base_volume, taker_buy_quote_volume, trade_count, is_closed, outlier_checked, source) VALUES (gen_random_uuid(), '15m', 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, true, true, 'x')",
    ],
    [
      'market_data_quarantine',
      "INSERT INTO market_data_quarantine (source, source_file, row_index, symbol, timeframe, reason, raw) VALUES ('x', 'x', 0, 'BTCUSDT', '15m', 'outlier', 'x')",
    ],
  ])('INSERT into %s fails with 42501', async (_, sql) => {
    expect(await attempt(client, sql)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CREATE DATABASE fails with 42501', async () => {
    // CREATE DATABASE cannot run inside a transaction block at all, so it runs
    // on its own, with the read-only default turned off for the session.
    await client.query('SET default_transaction_read_only = off');
    try {
      await client.query(`CREATE DATABASE ${newTestDatabaseName()}`);
      throw new Error('CREATE DATABASE succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).code).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await client.query('RESET default_transaction_read_only');
    }
  });
});

describe('a table that trader creates after the migrations ran', () => {
  beforeAll(async () => {
    // Stands in for a later migration.
    await withClient(testDatabaseUrl(first), async (trader) => {
      await trader.query(
        'CREATE TABLE public.later_table (id int PRIMARY KEY)',
      );
      await trader.query('INSERT INTO public.later_table VALUES (1)');
    });
  });

  it('is readable by research_reader', async () => {
    await withClient(researchUrl(first), async (client) => {
      const result = await client.query<{ id: number }>(
        'SELECT id FROM public.later_table',
      );
      expect(result.rows).toEqual([{ id: 1 }]);
    });
  });

  it.each([
    'INSERT INTO public.later_table VALUES (2)',
    'UPDATE public.later_table SET id = 3',
    'DELETE FROM public.later_table',
    'TRUNCATE public.later_table',
  ])('%s fails with 42501', async (sql) => {
    await withClient(researchUrl(first), async (client) => {
      expect(await attempt(client, sql)).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});
