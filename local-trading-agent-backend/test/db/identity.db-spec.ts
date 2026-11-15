import { Client, DatabaseError } from 'pg';
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

// The identity marker on the compose Postgres from `make db-up`, in throwaway
// `trader_test_*` databases created and dropped through the guarded helpers.

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let admin: Client;
const first = newTestDatabaseName();
const second = newTestDatabaseName();

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  for (const database of [first, second]) {
    await createTestDatabase(admin, database);
    const result = await runDbMigrate(testDatabaseUrl(database));
    if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
  }
});

afterAll(async () => {
  for (const database of [first, second]) {
    await dropTestDatabase(admin, database);
  }
  await admin.end();
});

async function insertError(sql: string): Promise<string | undefined> {
  return withClient(testDatabaseUrl(first), async (client) => {
    try {
      await client.query(sql);
      return undefined;
    } catch (error) {
      return error instanceof DatabaseError ? error.code : String(error);
    }
  });
}

describe('the database identity marker', () => {
  it('pnpm db:migrate leaves exactly one row, holding a UUID', async () => {
    const rows = await markerRows(first);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.marker).toMatch(UUID_V4);
  });

  it('records when the row was made, as timestamptz', async () => {
    const type = await withClient(testDatabaseUrl(first), async (client) => {
      const result = await client.query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
          WHERE attrelid = 'database_identity'::regclass AND attname = 'created_at'`,
      );
      return result.rows[0]?.type;
    });

    expect(type).toBe('timestamp with time zone');
  });

  it('two databases get different markers', async () => {
    const [a] = await markerRows(first);
    const [b] = await markerRows(second);

    expect(a?.marker).toMatch(UUID_V4);
    expect(b?.marker).toMatch(UUID_V4);
    expect(a?.marker).not.toBe(b?.marker);
  });

  it('a second pnpm db:migrate leaves the value and xmin unchanged', async () => {
    const before = await markerRows(first);

    const again = await runDbMigrate(testDatabaseUrl(first));

    expect(again.code).toBe(0);
    expect(await markerRows(first)).toEqual(before);
  });

  it('a second row fails as trader, by default or explicitly', async () => {
    const before = await markerRows(first);

    // 23505: the singleton primary key. 23514: the singleton check.
    expect(
      await insertError(
        'INSERT INTO database_identity (marker) VALUES (gen_random_uuid())',
      ),
    ).toBe('23505');
    expect(
      await insertError(
        'INSERT INTO database_identity (singleton, marker) VALUES (false, gen_random_uuid())',
      ),
    ).toBe('23514');
    expect(await markerRows(first)).toEqual(before);
  });
});
