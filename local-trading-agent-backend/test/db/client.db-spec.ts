import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { parseSettings } from '../../src/config/settings.js';
import { APPLICATION_NAME, connectDatabase } from '../../src/db/client.js';
import { IDENTITY } from '../../src/db/db.module.js';
import type { DatabaseIdentity } from '../../src/db/identity.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  markerRows,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
} from '../fixtures/db.js';

// The client against the compose Postgres from `make db-up`, on throwaway
// `trader_test_*` databases.

let admin: Client;
const migrated = newTestDatabaseName();
const empty = newTestDatabaseName();

beforeAll(async () => {
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  await createTestDatabase(admin, migrated);
  await createTestDatabase(admin, empty);
  const result = await runDbMigrate(testDatabaseUrl(migrated));
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
});

afterAll(async () => {
  await dropTestDatabase(admin, migrated);
  await dropTestDatabase(admin, empty);
  await admin.end();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The app's own connections to `database`, by application_name. */
async function appConnections(database: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname = $1 AND application_name = $2`,
    [database, APPLICATION_NAME],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function settle(database: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  let count = await appConnections(database);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await appConnections(database);
  }
  return count;
}

describe('connectDatabase', () => {
  const settingsFor = (database: string) =>
    parseSettings({
      DATABASE_URL: testDatabaseUrl(database),
      TRADER_MODE: 'paper',
    });

  it('reads the single marker of a migrated database', async () => {
    const [row] = await markerRows(migrated);
    const connection = await connectDatabase(settingsFor(migrated));
    try {
      expect(connection.marker).toEqual({
        kind: 'rows',
        markers: [row?.marker],
      });
    } finally {
      await connection.close();
    }
  });

  it('reads no table in a database with no migrations applied', async () => {
    const connection = await connectDatabase(settingsFor(empty));
    try {
      expect(connection.marker).toEqual({ kind: 'no_table' });
    } finally {
      await connection.close();
    }
  });

  it('runs its session in UTC whatever the server says', async () => {
    const connection = await connectDatabase(settingsFor(migrated));
    try {
      const result = await connection.db.$client.query<{ TimeZone: string }>(
        'SHOW TimeZone',
      );
      expect(result.rows[0]?.TimeZone).toBe('UTC');
    } finally {
      await connection.close();
    }
  });
});

describe('the application context and its connections', () => {
  it('leaves no connection in pg_stat_activity once the context is closed', async () => {
    vi.stubEnv('DATABASE_URL', testDatabaseUrl(migrated));
    vi.stubEnv('TRADER_MODE', 'paper');
    vi.stubEnv('DATABASE_IDENTITY', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);

    const app = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });
    // Control: the boot did connect, as the app.
    expect(await appConnections(migrated)).toBeGreaterThan(0);
    expect(app.get<DatabaseIdentity>(IDENTITY)).toMatchObject({
      status: 'UNKNOWN',
      reason: 'not_configured',
    });

    await app.close();

    expect(await settle(migrated)).toBe(0);
  });
});
