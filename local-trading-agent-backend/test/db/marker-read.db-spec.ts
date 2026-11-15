import { Client } from 'pg';
import { parseSettings } from '../../src/config/settings.js';
import { connectDatabase } from '../../src/db/client.js';
import { decideIdentity, identityLogFields } from '../../src/db/identity.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  testDatabaseUrl,
  withClient,
} from '../fixtures/db.js';

// S0f: stand-in databases built by hand, not migrated, whose marker table
// answers with an error or with a value that is not a string. Each read is
// `failed`, the identity is UNKNOWN `unreadable`, and nothing throws.

const ANY_MARKER = '9d5f0c1e-2b3a-4c5d-8e6f-7a8b9c0d1e2f';

let admin: Client;
const divisionByZero = newTestDatabaseName();
const integerMarker = newTestDatabaseName();
const nullMarker = newTestDatabaseName();
const databases = [divisionByZero, integerMarker, nullMarker];

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  for (const database of databases) await createTestDatabase(admin, database);
  await withClient(testDatabaseUrl(divisionByZero), (client) =>
    client.query(
      'CREATE VIEW database_identity AS SELECT (1/0)::text AS marker',
    ),
  );
  await withClient(testDatabaseUrl(integerMarker), async (client) => {
    await client.query('CREATE TABLE database_identity (marker integer)');
    await client.query('INSERT INTO database_identity VALUES (7)');
  });
  await withClient(testDatabaseUrl(nullMarker), async (client) => {
    await client.query('CREATE TABLE database_identity (marker text NULL)');
    await client.query('INSERT INTO database_identity VALUES (NULL)');
  });
});

afterAll(async () => {
  for (const database of databases) await dropTestDatabase(admin, database);
  await admin.end();
});

async function readOn(database: string) {
  const connection = await connectDatabase(
    parseSettings({
      DATABASE_URL: testDatabaseUrl(database),
      TRADER_MODE: 'paper',
    }),
  );
  try {
    return connection.marker;
  } finally {
    await connection.close();
  }
}

describe('a marker read that raises on the server', () => {
  it('keeps the SQLSTATE 22012 (division_by_zero) on the read and the identity', async () => {
    const read = await readOn(divisionByZero);

    expect(read).toStrictEqual({ kind: 'failed', sqlstate: '22012' });
    const identity = decideIdentity(ANY_MARKER, read);
    expect(identity).toStrictEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
      sqlstate: '22012',
    });
    expect(identityLogFields(identity)).toStrictEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
      sqlstate: '22012',
    });
  });
});

describe('a marker that is not a string', () => {
  it.each([
    ['database_identity(marker integer) holding 7', () => integerMarker],
    ['database_identity(marker text NULL) holding NULL', () => nullMarker],
  ])(
    '%s: a failed read, UNKNOWN unreadable, no marker',
    async (_, database) => {
      const read = await readOn(database());

      expect(read).toStrictEqual({ kind: 'failed' });
      const identity = decideIdentity(ANY_MARKER, read);
      expect(identity).toStrictEqual({
        status: 'UNKNOWN',
        reason: 'unreadable',
      });
      expect(identity).not.toHaveProperty('marker');
    },
  );
});
