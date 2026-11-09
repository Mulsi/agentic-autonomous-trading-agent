import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
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
 * The database a connection URL selects. A query string could select another
 * database (`?database=` or `?options=`), so any query string is refused.
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
