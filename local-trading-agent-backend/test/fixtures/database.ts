// A stand-in for the database connection, for unit tests that boot AppModule
// with no Postgres listening. Tests substitute `connectDatabase` with
// `fakeConnectDatabase` through `vi.mock`; production code has no switch.
import type { Database, DatabaseConnection } from '../../src/db/client.js';
import type { MarkerRead } from '../../src/db/identity.js';

export const FIXTURE_MARKER = '6f1c2b8e-3d4a-4e5f-9a7b-1c2d3e4f5a6b';

export interface FakeConnection extends DatabaseConnection {
  readonly closed: () => number;
}

export function fakeConnection(
  marker: MarkerRead = { kind: 'rows', markers: [FIXTURE_MARKER] },
): FakeConnection {
  let closes = 0;
  return {
    db: { fake: 'drizzle' } as unknown as Database,
    marker,
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    closed: () => closes,
  };
}

/** Same signature as `connectDatabase`; opens nothing. */
export function fakeConnectDatabase(): Promise<DatabaseConnection> {
  return Promise.resolve(fakeConnection());
}
