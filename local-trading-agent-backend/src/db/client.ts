import { userInfo } from 'node:os';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig, type QueryConfig } from 'pg';
import { databaseTarget } from '../config/secrets.js';
import type { Settings } from '../config/settings.js';
import { markerReadFailure, type MarkerRead } from './identity.js';
import * as schema from './schema.js';

// The one place under src/ that opens a database connection. It changes no type
// parser, global or per pool: `numeric` and `int8` stay strings, and
// `timestamptz` keeps the driver's own parsing.

/** A server that accepts the connection and never answers fails the boot. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** The marker read gives up after this long, and the identity is UNKNOWN. */
export const MARKER_READ_TIMEOUT_MS = 5_000;
export const APPLICATION_NAME = 'local-trading-agent';
const DEFAULT_PORT = 5432;

/** The Drizzle instance, with the pool underneath it as `$client`. */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

export interface DatabaseConnection {
  readonly db: Database;
  /** What the boot found in the marker table. */
  readonly marker: MarkerRead;
  /** Ends every pooled connection. */
  close(): Promise<void>;
}

/** Sent when the URL has no password, so pg never reads PGPASSWORD or .pgpass. */
const noPassword = (): string => '';

/**
 * The pool configuration, from the settings alone.
 *
 * pg fills any falsy field from the environment (PGHOST, PGPORT, PGUSER,
 * PGPASSWORD, PGDATABASE, PGOPTIONS, PGAPPNAME, PGSSLMODE, ...). Settings are
 * parsed once and nothing reads the environment again, so every field pg would
 * look up is set here, with the libpq defaults where the URL is silent: port
 * 5432, the operating-system user, and a database named after the user. No
 * `connectionString`: pg's own URL parser re-encodes some passwords into a form
 * the log scrub does not know, and throws on others that the settings accept.
 */
export function databaseConfig(settings: Settings): PoolConfig {
  const target = databaseTarget(settings.DATABASE_URL);
  const user = target.user === '' ? userInfo().username : target.user;
  const config: PoolConfig & { replication: string } = {
    host: target.host,
    // pg treats a falsy port as unset and reads PGPORT, so port 0 travels as
    // text, which pg parses back with parseInt.
    port: (target.port === 0 ? '0' : (target.port ?? DEFAULT_PORT)) as number,
    user,
    password: target.password === '' ? noPassword : target.password,
    database: target.database === '' ? user : target.database,
    ssl: false,
    sslnegotiation: 'postgres',
    client_encoding: 'utf8',
    application_name: APPLICATION_NAME,
    // A plain session, and UTC for the session too (D12).
    replication: 'false',
    options: '-c TimeZone=UTC',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Idle pooled connections never keep the process alive on their own.
    allowExitOnIdle: true,
  };
  return config;
}

/**
 * Opens the pool, proves one connection, and reads the identity marker. A
 * failed connect rejects, once, with no retry (D11, Rule 9). A failed read
 * after the connection opened does not: it comes back as the marker read.
 */
export async function connectDatabase(
  settings: Settings,
): Promise<DatabaseConnection> {
  const pool = new Pool(databaseConfig(settings));
  const db = drizzle({ client: pool, schema });

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }

  const marker = await readMarker(db, client);
  return { db, marker, close: () => pool.end() };
}

async function readMarker(
  db: Database,
  client: PoolClient,
): Promise<MarkerRead> {
  const { sql, params } = db
    .select({ marker: schema.databaseIdentity.marker })
    .from(schema.databaseIdentity)
    .limit(2)
    .toSQL();
  const query: QueryConfig & { query_timeout: number } = {
    text: sql,
    values: params,
    query_timeout: MARKER_READ_TIMEOUT_MS,
  };
  // A checked-out client has no `error` listener, and pg emits `error` when the
  // connection is lost mid-query. Unheard, that would crash the boot. While the
  // read runs, this listener hears it; the query itself then rejects, and the
  // read is `failed` (UNKNOWN `unreadable`).
  client.on('error', ignoreDuringRead);
  let read: MarkerRead;
  let broken = false;
  try {
    const result = await client.query<{ marker: string }>(query);
    read = { kind: 'rows', markers: result.rows.map((row) => row.marker) };
  } catch (error) {
    // The connection may be mid-query or broken: discard it.
    broken = true;
    read = markerReadFailure(error);
  } finally {
    // Release first: the pool puts its own error listener back on the client.
    client.release(broken);
    client.off('error', ignoreDuringRead);
  }
  return read;
}

/** The query's own rejection carries the failure; the event adds nothing. */
function ignoreDuringRead(): void {
  // Nothing to do: see readMarker.
}
