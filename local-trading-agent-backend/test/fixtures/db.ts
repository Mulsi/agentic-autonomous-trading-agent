import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { appRoot, readRepoFile } from './repo.js';

// DB tests touch only throwaway databases with this prefix, so no test run can
// reach the `trader` database or a paper-run ledger. Every helper that creates,
// migrates or drops a database goes through `assertTestDatabaseName`.
export const TEST_DB_PREFIX = 'trader_test_';
const TEST_DB_NAME = /^trader_test_[a-z0-9_]{1,40}$/;

export class UnsafeDatabaseError extends Error {
  override readonly name = 'UnsafeDatabaseError';
}

/** Returns the name, or throws unless it is a test database name. */
export function assertTestDatabaseName(name: string): string {
  if (!TEST_DB_NAME.test(name)) {
    throw new UnsafeDatabaseError(
      `Refusing to touch database "${name}": DB tests only touch ${TEST_DB_PREFIX}* databases`,
    );
  }
  return name;
}

/**
 * The database a connection URL selects. pg copies every query parameter into
 * its config, so `?host=`, `?port=` or `?options=` could send the run elsewhere.
 * Any query string is refused.
 */
export function databaseOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new UnsafeDatabaseError(
      'Refusing a test database URL with a query string',
    );
  }
  return decodeURIComponent(parsed.pathname.slice(1));
}

export function newTestDatabaseName(): string {
  return `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
}

/**
 * The compose server's URL, from the committed `.env.example`, pointed at
 * another database. `.env` is never read.
 */
export function composeUrl(database: string): string {
  const { DATABASE_URL } = parseEnv(readRepoFile('.env.example'));
  if (DATABASE_URL === undefined) throw new Error('.env.example: no URL');
  const url = new URL(DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `composeUrl` for a test database only: the guard runs first. */
export function testDatabaseUrl(database: string): string {
  return composeUrl(assertTestDatabaseName(database));
}

/** Runs `body` with a client connected to `url`, and always ends it. */
export async function withClient<T>(
  url: string,
  body: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

export interface DbObject {
  schema: string;
  name: string;
  kind: string;
}

/**
 * Every relation (table, view, sequence, index, ...), function and type in a
 * non-system schema of a test database, leaving out the schemas in `skip`.
 */
export function userObjects(
  database: string,
  skip: readonly string[],
): Promise<DbObject[]> {
  return withClient(testDatabaseUrl(database), async (client) => {
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

export interface MarkerRow {
  marker: string;
  xmin: string;
}

/** Every row of the marker table, with its `xmin`, in a test database. */
export function markerRows(database: string): Promise<MarkerRow[]> {
  return withClient(testDatabaseUrl(database), async (client) => {
    const result = await client.query<MarkerRow>(
      'SELECT marker::text AS marker, xmin::text AS xmin FROM database_identity',
    );
    return result.rows;
  });
}

/** The part of `pg.Client` the helpers use, so unit tests can pass a stub. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

export async function createTestDatabase(
  admin: Queryable,
  name: string,
): Promise<void> {
  assertTestDatabaseName(name);
  await admin.query(`CREATE DATABASE "${name}"`);
}

export async function dropTestDatabase(
  admin: Queryable,
  name: string,
): Promise<void> {
  assertTestDatabaseName(name);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** Creates a test database, runs `body`, and drops it even if `body` throws. */
export async function withTestDatabase<T>(
  admin: Queryable,
  body: (name: string) => Promise<T>,
): Promise<T> {
  const name = newTestDatabaseName();
  await createTestDatabase(admin, name);
  try {
    return await body(name);
  } finally {
    await dropTestDatabase(admin, name);
  }
}

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const MIGRATE_LIMIT_MS = 45_000;

/**
 * Runs `pnpm db:migrate` in the app folder as a child process. The env is
 * explicit: PATH and HOME so pnpm and node resolve, plus DATABASE_URL when a
 * URL is given, and that URL must select a test database. `undefined` runs
 * with DATABASE_URL unset, which touches no database.
 */
export async function runDbMigrate(
  url: string | undefined,
): Promise<RunResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  };
  if (url !== undefined) {
    assertTestDatabaseName(databaseOf(url));
    env.DATABASE_URL = url;
  }
  return await runCommand('pnpm', ['db:migrate'], appRoot, env);
}

/** Spawns a command with an explicit env and collects its output. */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, MIGRATE_LIMIT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
}
