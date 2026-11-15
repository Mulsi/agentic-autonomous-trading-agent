import { and, eq } from 'drizzle-orm';
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

// S0f evidence tables, also only in the throwaway database.
const int8Table = pgTable('fx_int8', {
  id: integer('id').primaryKey(),
  n: bigint('n', { mode: 'bigint' }),
});
const numericArray = pgTable('fx_numeric_array', {
  id: integer('id').primaryKey(),
  v: numeric('v').array(),
});
const fxNow = pgTable('fx_now', {
  id: integer('id').primaryKey(),
  at6: timestamp('at6', { withTimezone: true }),
  at3: timestamp('at3', { withTimezone: true, precision: 3 }),
});
const fxNowDefault = pgTable('fx_now_default', {
  id: integer('id').primaryKey(),
  at3: timestamp('at3', { withTimezone: true, precision: 3 }),
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
    await client.query(
      `CREATE TABLE fx_int8 (id integer PRIMARY KEY, n int8);
       INSERT INTO fx_int8 VALUES (1, 9007199254740993);
       CREATE TABLE fx_numeric_array (id integer PRIMARY KEY, v numeric[]);
       INSERT INTO fx_numeric_array VALUES (1, '{1.10,-0.00000001}');
       CREATE TABLE fx_now (
         id integer PRIMARY KEY,
         at6 timestamptz DEFAULT '2024-01-15 12:00:00.123987+00',
         at3 timestamptz(3) DEFAULT '2024-01-15 12:00:00.123987+00'
       );
       INSERT INTO fx_now (id) VALUES (1);
       CREATE TABLE fx_now_default (
         id integer PRIMARY KEY,
         at3 timestamptz(3) DEFAULT now()
       );`,
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

describe('int8, jsonb and numeric[] through the raw pool (S0f)', () => {
  it('a literal int8 beyond 2^53 comes back as the identical string', async () => {
    const result = await connection.db.$client.query<{ n: unknown }>(
      'SELECT 9007199254740993::int8 AS n',
    );

    expect(result.rows[0]?.n).toBe('9007199254740993');
    expect(typeof result.rows[0]?.n).toBe('string');
  });

  it('an int8 column holding it comes back as the identical string', async () => {
    const result = await connection.db.$client.query<{ n: unknown }>(
      'SELECT n FROM fx_int8 WHERE id = 1',
    );

    expect(result.rows[0]?.n).toBe('9007199254740993');
    expect(typeof result.rows[0]?.n).toBe('string');
  });

  it('control: through Drizzle a bigint-mode int8 is a JS bigint', async () => {
    const [row] = await connection.db
      .select({ n: int8Table.n })
      .from(int8Table);

    expect(row?.n).toBe(9007199254740993n);
  });

  it('control for the JSON ban: a jsonb number comes back as a JS number', async () => {
    const result = await connection.db.$client.query<{ j: { p: unknown } }>(
      `SELECT '{"p": 0.10}'::jsonb AS j`,
    );

    expect(typeof result.rows[0]?.j.p).toBe('number');
    expect(result.rows[0]?.j.p).toBe(0.1);
  });

  // The evidence for the numeric-array ban is the raw pool: pg-types parses
  // numeric[] (OID 1231) with parseFloat, so money there is a JS number.
  it('numeric[] through the raw pool: JS numbers, not the stored strings', async () => {
    const result = await connection.db.$client.query<{ v: unknown[] }>(
      'SELECT v FROM fx_numeric_array WHERE id = 1',
    );
    const values = result.rows[0]?.v ?? [];

    expect(values).toEqual([1.1, -1e-8]);
    expect(values.map((value) => typeof value)).toEqual(['number', 'number']);
  });

  // Drizzle's node-postgres session replaces the OID 1231 parser on its own
  // queries, so this path keeps the stored text. The ban stands anyway: the
  // same column read through the raw pool (above) gives JS numbers.
  it('numeric[] through Drizzle: the identical stored strings', async () => {
    const [row] = await connection.db
      .select({ v: numericArray.v })
      .from(numericArray);

    expect(row?.v).toEqual(['1.10', '-0.00000001']);
    expect(row?.v?.map((value) => typeof value)).toEqual(['string', 'string']);
  });
});

describe('server-filled timestamptz: microseconds against milliseconds (D12, S0f)', () => {
  it('through Drizzle: = on the Date read from at6 misses, from at3 finds the row', async () => {
    const [row] = await connection.db
      .select({ at6: fxNow.at6, at3: fxNow.at3 })
      .from(fxNow)
      .where(eq(fxNow.id, 1));
    expect(row?.at6).toBeInstanceOf(Date);
    expect(row?.at3).toBeInstanceOf(Date);
    const at6 = row?.at6 ?? new Date(0);
    const at3 = row?.at3 ?? new Date(0);
    // The µs are gone in JS; precision 3 rounded them to .124 on the server.
    expect(at6.toISOString()).toBe('2024-01-15T12:00:00.123Z');
    expect(at3.toISOString()).toBe('2024-01-15T12:00:00.124Z');

    const by6 = await connection.db
      .select({ id: fxNow.id })
      .from(fxNow)
      .where(eq(fxNow.at6, at6));
    const by3 = await connection.db
      .select({ id: fxNow.id })
      .from(fxNow)
      .where(eq(fxNow.at3, at3));

    expect(by6).toHaveLength(0);
    expect(by3).toEqual([{ id: 1 }]);
  });

  it('through the raw pool: the same', async () => {
    const pool = connection.db.$client;
    const read = await pool.query<{ at6: Date; at3: Date }>(
      'SELECT at6, at3 FROM fx_now WHERE id = 1',
    );
    const row = read.rows[0];
    expect(row?.at6).toBeInstanceOf(Date);
    expect(row?.at3).toBeInstanceOf(Date);

    const by6 = await pool.query('SELECT id FROM fx_now WHERE at6 = $1', [
      row?.at6,
    ]);
    const by3 = await pool.query('SELECT id FROM fx_now WHERE at3 = $1', [
      row?.at3,
    ]);

    expect(by6.rowCount).toBe(0);
    expect(by3.rowCount).toBe(1);
  });

  it('20 rows with at3 timestamptz(3) DEFAULT now() are each found again by =', async () => {
    for (let id = 1; id <= 20; id += 1) {
      await connection.db.$client.query(
        'INSERT INTO fx_now_default (id) VALUES ($1)',
        [id],
      );
    }
    const rows = await connection.db
      .select({ id: fxNowDefault.id, at3: fxNowDefault.at3 })
      .from(fxNowDefault)
      .orderBy(fxNowDefault.id);
    expect(rows).toHaveLength(20);

    for (const { id, at3 } of rows) {
      expect(at3).toBeInstanceOf(Date);
      const found = await connection.db
        .select({ id: fxNowDefault.id })
        .from(fxNowDefault)
        .where(
          and(
            eq(fxNowDefault.id, id),
            eq(fxNowDefault.at3, at3 ?? new Date(0)),
          ),
        );
      expect(found).toEqual([{ id }]);
    }
  });
});
