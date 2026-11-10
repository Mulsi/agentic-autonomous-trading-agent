import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, DatabaseError } from 'pg';
import { CONNECT_TIMEOUT_MS } from '../src/db/client.js';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  markerRows,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
  userObjects,
  withClient,
  type MarkerRow,
} from './fixtures/db.js';
import { FIXTURE_DB_PASSWORD } from './fixtures/env.js';
import { REDACTED } from './fixtures/logs.js';
import {
  closedPort,
  countingListener,
  EXIT_LIMIT_MS,
  jsonLines,
  runMain,
  type MainResult,
} from './fixtures/main.js';
import { appRoot } from './fixtures/repo.js';

// The built app against the compose Postgres from `make db-up`, in throwaway
// `trader_test_*` databases, and against loopback listeners that stand in for a
// broken server.

const S = FIXTURE_DB_PASSWORD;
const RUN_LIMIT_MS = EXIT_LIMIT_MS + 5_000;

let admin: Client;
const first = newTestDatabaseName();
const second = newTestDatabaseName();
const unmigrated = newTestDatabaseName();
let firstRows: MarkerRow[];
let secondRows: MarkerRow[];

beforeAll(async () => {
  if (!existsSync(join(appRoot, 'dist/main.js'))) {
    throw new Error('dist/main.js is missing. Run pnpm build first.');
  }
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  for (const database of [first, second, unmigrated]) {
    await createTestDatabase(admin, database);
  }
  for (const database of [first, second]) {
    const result = await runDbMigrate(testDatabaseUrl(database));
    if (result.code !== 0) throw new Error(`migrate: ${result.stderr}`);
  }
  firstRows = await markerRows(first);
  secondRows = await markerRows(second);
});

afterAll(async () => {
  for (const database of [first, second, unmigrated]) {
    await dropTestDatabase(admin, database);
  }
  await admin.end();
});

function schemaExists(database: string, schema: string): Promise<boolean> {
  return withClient(testDatabaseUrl(database), async (client) => {
    const result = await client.query(
      'SELECT 1 FROM pg_namespace WHERE nspname = $1',
      [schema],
    );
    return result.rowCount === 1;
  });
}

function marker(rows: MarkerRow[]): string {
  const value = rows[0]?.marker;
  if (rows.length !== 1 || value === undefined) throw new Error('no marker');
  return value;
}

describe('the identity line at boot', () => {
  interface Case {
    name: string;
    database: () => string;
    identity: () => string | undefined;
    level: 'info' | 'warn';
    status: 'VERIFIED' | 'UNKNOWN';
    reason?: string;
    stored: boolean;
  }

  const cases: Case[] = [
    {
      name: 'DATABASE_IDENTITY unset',
      database: () => first,
      identity: () => undefined,
      level: 'warn',
      status: 'UNKNOWN',
      reason: 'not_configured',
      stored: true,
    },
    {
      name: "DATABASE_IDENTITY set to ''",
      database: () => first,
      identity: () => '',
      level: 'warn',
      status: 'UNKNOWN',
      reason: 'not_configured',
      stored: true,
    },
    {
      name: "the database's own marker",
      database: () => first,
      identity: () => marker(firstRows),
      level: 'info',
      status: 'VERIFIED',
      stored: true,
    },
    {
      name: "another database's marker",
      database: () => first,
      identity: () => marker(secondRows),
      level: 'warn',
      status: 'UNKNOWN',
      reason: 'mismatch',
      stored: true,
    },
    {
      name: 'the marker in upper case',
      database: () => first,
      identity: () => marker(firstRows).toUpperCase(),
      level: 'warn',
      status: 'UNKNOWN',
      reason: 'mismatch',
      stored: true,
    },
    {
      name: 'any UUID, on a database with no migrations applied',
      database: () => unmigrated,
      identity: () => '9d5f0c1e-2b3a-4c5d-8e6f-7a8b9c0d1e2f',
      level: 'warn',
      status: 'UNKNOWN',
      reason: 'missing_marker',
      stored: false,
    },
  ];

  it.each(cases)(
    '$name: exits 0 and logs exactly one identity line before the startup line',
    async (testCase) => {
      const identity = testCase.identity();
      const result = await runMain({
        DATABASE_URL: testDatabaseUrl(testCase.database()),
        TRADER_MODE: 'paper',
        ...(identity === undefined ? {} : { DATABASE_IDENTITY: identity }),
      });

      expect(result.timedOut).toBe(false);
      expect(result.code, result.stderr).toBe(0);
      const lines = jsonLines(result);
      const identityAt = lines.flatMap((line, index) =>
        line.msg === 'Database identity' ? [index] : [],
      );
      const startupAt = lines.findIndex((line) => line.mode !== undefined);
      expect(identityAt).toHaveLength(1);
      expect(identityAt[0]).toBeLessThan(startupAt);

      const line = lines[identityAt[0] ?? -1];
      expect(line).toMatchObject({
        level: testCase.level,
        status: testCase.status,
        context: 'Database',
      });
      expect(line?.reason).toBe(testCase.reason);
      expect(line?.marker).toBe(
        testCase.stored ? marker(firstRows) : undefined,
      );

      // A boot never writes.
      expect(await markerRows(first)).toEqual(firstRows);
      expect(await markerRows(second)).toEqual(secondRows);
      expect(await userObjects(unmigrated, [])).toEqual([]);
      expect(await schemaExists(unmigrated, 'drizzle')).toBe(false);
    },
    RUN_LIMIT_MS,
  );
});

describe('a failed connect at boot prints no password', () => {
  /** The common D11 contract: loud, non-zero, no signal, no secret. */
  function expectLoudFailure(result: MainResult, url: string): void {
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.code).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(S);
      expect(stream).not.toContain(url);
    }
  }

  const withPassword = (port: number): string =>
    `postgresql://trader:${S}@127.0.0.1:${port}/trader`;

  it(
    '(a) nothing listens on the port: stderr names the refusal',
    async () => {
      const url = withPassword(await closedPort());

      const result = await runMain({ DATABASE_URL: url, TRADER_MODE: 'paper' });

      expectLoudFailure(result, url);
      expect(result.stderr).toContain('ECONNREFUSED');
    },
    RUN_LIMIT_MS,
  );

  it(
    '(b) a listener closes each connection at once: one connection, no retry',
    async () => {
      const listener = await countingListener('close-at-once');
      const url = withPassword(listener.port);
      try {
        const result = await runMain({
          DATABASE_URL: url,
          TRADER_MODE: 'paper',
        });

        expectLoudFailure(result, url);
        expect(result.stderr).toMatch(/Connection terminated/);
        expect(listener.connections()).toBe(1);
      } finally {
        await listener.close();
      }
    },
    RUN_LIMIT_MS,
  );

  it(
    '(c) a listener accepts and never answers: the connect timeout fails the boot',
    async () => {
      const listener = await countingListener('silent');
      const url = withPassword(listener.port);
      try {
        const started = Date.now();
        const result = await runMain({
          DATABASE_URL: url,
          TRADER_MODE: 'paper',
        });
        const elapsed = Date.now() - started;

        expectLoudFailure(result, url);
        expect(result.stderr).toMatch(/timeout/i);
        expect(listener.connections()).toBe(1);
        expect(elapsed).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(EXIT_LIMIT_MS);
      } finally {
        await listener.close();
      }
    },
    RUN_LIMIT_MS,
  );

  it(
    '(d) the compose server with a wrong password: the authentication failure',
    async () => {
      const url = new URL(testDatabaseUrl(newTestDatabaseName()));
      url.password = S;

      const result = await runMain({
        DATABASE_URL: url.toString(),
        TRADER_MODE: 'paper',
      });

      expectLoudFailure(result, url.toString());
      expect(result.stderr).toContain(
        'password authentication failed for user "trader"',
      );
      expect(result.stderr).toContain('28P01');
    },
    RUN_LIMIT_MS,
  );

  it(
    '(e) a server error that holds the password: [REDACTED] in its place',
    async () => {
      const url = new URL(testDatabaseUrl(newTestDatabaseName()));
      url.username = S;
      url.password = S;

      // Control: the driver's own error text carries the password.
      const raw = new Client({ connectionString: url.toString() });
      const error = await raw.connect().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).message).toContain(S);

      const result = await runMain({
        DATABASE_URL: url.toString(),
        TRADER_MODE: 'paper',
      });

      expectLoudFailure(result, url.toString());
      expect(result.stderr).toContain(
        `password authentication failed for user "${REDACTED}"`,
      );
    },
    RUN_LIMIT_MS,
  );
});
