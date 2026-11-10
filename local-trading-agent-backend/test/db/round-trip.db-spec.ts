import { eq } from 'drizzle-orm';
import {
  bigint,
  integer,
  numeric,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { parseSettings } from '../../src/config/settings.js';
import {
  connectDatabase,
  type DatabaseConnection,
} from '../../src/db/client.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  testDatabaseUrl,
  withClient,
} from '../fixtures/db.js';

// Time and money through the client that src/db/client.ts builds, on a
// throwaway database, in a process whose zone is not UTC. The test table lives
// only in that database; src/db/schema.ts does not gain it.

const roundTrip = pgTable('round_trip', {
  id: integer('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }),
  atMs: bigint('at_ms', { mode: 'number' }),
  amount: numeric('amount'),
});

const INSTANTS = [
  // The same local time in Ljubljana, an hour apart: the autumn change.
  '2024-10-27T00:30:00.000Z',
  '2024-10-27T01:30:00.000Z',
  // The last millisecond before the spring change.
  '2024-03-31T00:59:59.999Z',
];
const AMOUNTS = [
  '123456789012345678901234567890.123456789012345678',
  '-0.00000001',
  '1.10',
];

// Set before this file makes any Date (the imports above make none at load).
// Node applies a change to process.env.TZ at once.
const previousTz = process.env.TZ;
process.env.TZ = 'Europe/Ljubljana';

let admin: Client;
let connection: DatabaseConnection;
const database = newTestDatabaseName();

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  await createTestDatabase(admin, database);
  await withClient(testDatabaseUrl(database), async (client) => {
    await client.query(
      `CREATE TABLE round_trip (
         id integer PRIMARY KEY,
         at timestamptz,
         at_ms bigint,
         amount numeric,
         naive timestamp without time zone
       )`,
    );
  });
  connection = await connectDatabase(
    parseSettings({
      DATABASE_URL: testDatabaseUrl(database),
      TRADER_MODE: 'paper',
    }),
  );
});

afterAll(async () => {
  await connection.close();
  await dropTestDatabase(admin, database);
  await admin.end();
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe('the precondition', () => {
  it('runs with a non-UTC local zone', () => {
    expect(process.env.TZ).toBe('Europe/Ljubljana');
    expect(new Date('2024-01-15T12:00:00Z').getTimezoneOffset()).not.toBe(0);
    expect(new Date('2024-01-15T12:00:00Z').getTimezoneOffset()).toBe(-60);
  });

  it('the two autumn instants show the same local time', () => {
    const local = (iso: string) =>
      new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: 'Europe/Ljubljana',
      });

    expect(local(INSTANTS[0] ?? '')).toBe(local(INSTANTS[1] ?? ''));
  });
});

describe('a round trip through the client', () => {
  beforeAll(async () => {
    await connection.db.insert(roundTrip).values(
      INSTANTS.map((iso, index) => ({
        id: index + 1,
        at: new Date(iso),
        atMs: new Date(iso).getTime(),
        amount: AMOUNTS[index] ?? null,
      })),
    );
  });

  it.each(INSTANTS.map((iso, index) => [iso, index + 1] as const))(
    'timestamptz %s comes back with the same getTime() through Drizzle',
    async (iso, id) => {
      const [row] = await connection.db
        .select({ at: roundTrip.at })
        .from(roundTrip)
        .where(eq(roundTrip.id, id));

      expect(row?.at).toBeInstanceOf(Date);
      expect(row?.at?.getTime()).toBe(new Date(iso).getTime());
    },
  );

  it.each(INSTANTS.map((iso, index) => [iso, index + 1] as const))(
    'timestamptz %s comes back with the same getTime() through the raw pool',
    async (iso, id) => {
      const result = await connection.db.$client.query<{ at: Date }>(
        'SELECT at FROM round_trip WHERE id = $1',
        [id],
      );

      expect(result.rows[0]?.at).toBeInstanceOf(Date);
      expect(result.rows[0]?.at.getTime()).toBe(new Date(iso).getTime());
    },
  );

  it('epoch milliseconds in a number-mode *_ms bigint come back as the same number', async () => {
    const rows = await connection.db
      .select({ id: roundTrip.id, atMs: roundTrip.atMs })
      .from(roundTrip)
      .orderBy(roundTrip.id);

    expect(rows.map((row) => row.atMs)).toEqual(
      INSTANTS.map((iso) => new Date(iso).getTime()),
    );
    expect(typeof rows[0]?.atMs).toBe('number');
  });

  it('numeric comes back as the identical string through Drizzle', async () => {
    const rows = await connection.db
      .select({ amount: roundTrip.amount })
      .from(roundTrip)
      .orderBy(roundTrip.id);

    expect(rows.map((row) => row.amount)).toEqual(AMOUNTS);
  });

  it('numeric comes back as the identical string through the raw pool', async () => {
    const result = await connection.db.$client.query<{ amount: unknown }>(
      'SELECT amount FROM round_trip ORDER BY id',
    );

    expect(result.rows.map((row) => row.amount)).toEqual(AMOUNTS);
    for (const row of result.rows) expect(typeof row.amount).toBe('string');
  });

  it('control: timestamp without time zone through the raw pool shifts by the local offset', async () => {
    await connection.db.$client.query(
      `INSERT INTO round_trip (id, naive) VALUES (100, '2024-01-15 12:00:00')`,
    );

    const result = await connection.db.$client.query<{ naive: Date }>(
      'SELECT naive FROM round_trip WHERE id = 100',
    );
    const utc = Date.UTC(2024, 0, 15, 12, 0, 0);
    const read = result.rows[0]?.naive.getTime() ?? 0;

    // The driver reads it as Ljubljana local time, one hour ahead of UTC.
    expect(read).not.toBe(utc);
    expect(read - utc).toBe(new Date(utc).getTimezoneOffset() * 60_000);
  });
});
