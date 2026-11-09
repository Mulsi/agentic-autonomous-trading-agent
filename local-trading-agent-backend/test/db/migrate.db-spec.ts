import { createServer, type AddressInfo } from 'node:net';
import { Client } from 'pg';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  withTestDatabase,
  type RunResult,
} from '../fixtures/db.js';

// Runs against the compose Postgres from `make db-up`. Every database here is
// a throwaway `trader_test_*` one, created and dropped through the guarded
// helpers in test/fixtures/db.ts.

const WRONG_PASSWORD = 'wrong-password-sentinel-3c9e';

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

async function withClient<T>(
  database: string,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: composeUrl(database) });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

interface MigrationRow {
  hash: string;
  created_at: string;
}

function migrationRows(database: string): Promise<MigrationRow[]> {
  return withClient(database, async (client) => {
    const result = await client.query<MigrationRow>(
      'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    return result.rows;
  });
}

interface DbObject {
  schema: string;
  name: string;
  kind: string;
}

/**
 * Every relation (table, view, sequence, index, ...), function and type in a
 * non-system schema, leaving out the schemas named in `skip`.
 */
function userObjects(database: string, skip: string[]): Promise<DbObject[]> {
  return withClient(database, async (client) => {
    const result = await client.query<DbObject>(
      `WITH user_schemas AS (
         SELECT oid, nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg\\_toast%'
           AND nspname NOT LIKE 'pg\\_temp\\_%'
           AND nspname <> ALL($1::text[])
       )
       SELECT s.nspname AS schema, c.relname AS name, 'relation ' || c.relkind::text AS kind
         FROM pg_class c JOIN user_schemas s ON s.oid = c.relnamespace
       UNION ALL
       SELECT s.nspname, p.proname, 'function'
         FROM pg_proc p JOIN user_schemas s ON s.oid = p.pronamespace
       UNION ALL
       SELECT s.nspname, t.typname, 'type'
         FROM pg_type t JOIN user_schemas s ON s.oid = t.typnamespace
       ORDER BY 1, 2, 3`,
      [skip],
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

  it("records exactly one row in drizzle's migrations table", async () => {
    expect(await migrationRows(database)).toHaveLength(1);
  });

  it("creates nothing outside drizzle's bookkeeping schema", async () => {
    expect(await userObjects(database, ['drizzle'])).toEqual([]);
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

  it('a second run exits 0 and leaves the same single row', async () => {
    const before = await migrationRows(database);

    const second = await runDbMigrate(composeUrl(database));

    expect(second.code, output(second)).toBe(0);
    expect(await migrationRows(database)).toEqual(before);
    expect(before).toHaveLength(1);
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
