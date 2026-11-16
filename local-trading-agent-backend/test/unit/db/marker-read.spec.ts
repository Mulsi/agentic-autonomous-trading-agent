import { parseSettings } from '../../../src/config/settings.js';
import {
  connectDatabase,
  MARKER_READ_TIMEOUT_MS,
} from '../../../src/db/client.js';
import { decideIdentity, identityLogFields } from '../../../src/db/identity.js';
import {
  fakePostgres,
  type FakePostgres,
} from '../../fixtures/fake-postgres.js';

// The marker read against a fake server that misbehaves after the connection
// opened (S0e round 2). Either way the read is `failed`, the identity is
// UNKNOWN `unreadable`, and nothing is thrown: the boot carries on.

const ANY_MARKER = '0b9f5a52-6c1e-4d8a-9f3b-2e7c4d1a8b60';
const MARGIN_MS = 2_000;

let server: FakePostgres | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function settingsFor(fake: FakePostgres) {
  return parseSettings({ DATABASE_URL: fake.url, TRADER_MODE: 'paper' });
}

describe('the marker read', () => {
  it('a connection reset mid-read is a failed read, not a crash', async () => {
    server = await fakePostgres('reset-on-query');

    const connection = await connectDatabase(settingsFor(server));
    try {
      expect(connection.marker).toEqual({ kind: 'failed' });
      expect(connection.marker).not.toHaveProperty('sqlstate');
      expect(decideIdentity(ANY_MARKER, connection.marker)).toEqual({
        status: 'UNKNOWN',
        reason: 'unreadable',
      });
      // The connection was made, the read was sent, and nothing retried.
      expect(server.connections()).toBe(1);
      expect(server.queries()).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it('the pool still closes cleanly after the reset', async () => {
    server = await fakePostgres('reset-on-query');
    const connection = await connectDatabase(settingsFor(server));

    await expect(connection.close()).resolves.toBeUndefined();
  });

  it(
    'a read that never answers fails within the read timeout',
    async () => {
      server = await fakePostgres('silent-on-query');

      const started = Date.now();
      const connection = await connectDatabase(settingsFor(server));
      const elapsed = Date.now() - started;
      try {
        expect(connection.marker).toEqual({ kind: 'failed' });
        expect(connection.marker).not.toHaveProperty('sqlstate');
        expect(decideIdentity(ANY_MARKER, connection.marker)).toEqual({
          status: 'UNKNOWN',
          reason: 'unreadable',
        });
        expect(server.queries()).toBe(1);
        expect(elapsed).toBeGreaterThanOrEqual(MARKER_READ_TIMEOUT_MS - 50);
        expect(elapsed).toBeLessThan(MARKER_READ_TIMEOUT_MS + MARGIN_MS);
      } finally {
        await connection.close();
      }
    },
    MARKER_READ_TIMEOUT_MS + MARGIN_MS + 5_000,
  );

  it('the read timeout is the one the client sets on the query', () => {
    // Bounded well inside the e2e exit limit, so a hung read cannot hang a boot.
    expect(MARKER_READ_TIMEOUT_MS).toBe(5_000);
  });
});

describe('an ErrorResponse to the marker read (S0f)', () => {
  const SENTINEL = 'server-message-sentinel-5d2e';

  it('keeps the SQLSTATE, and nothing else from the error', async () => {
    server = await fakePostgres({
      kind: 'error-on-query',
      sqlstate: 'XX000',
      message: `internal error ${SENTINEL}`,
    });

    const connection = await connectDatabase(settingsFor(server));
    try {
      expect(connection.marker).toStrictEqual({
        kind: 'failed',
        sqlstate: 'XX000',
      });
      const identity = decideIdentity(ANY_MARKER, connection.marker);
      expect(identity).toStrictEqual({
        status: 'UNKNOWN',
        reason: 'unreadable',
        sqlstate: 'XX000',
      });
      const fields = identityLogFields(identity);
      expect(fields).toStrictEqual({
        status: 'UNKNOWN',
        reason: 'unreadable',
        sqlstate: 'XX000',
      });
      for (const value of [connection.marker, identity, fields]) {
        expect(JSON.stringify(value)).not.toContain(SENTINEL);
      }
      // One connection, one query, no retry.
      expect(server.connections()).toBe(1);
      expect(server.queries()).toBe(1);
    } finally {
      // The pool closes cleanly after the error.
      await expect(connection.close()).resolves.toBeUndefined();
    }
  });

  it('a malformed code from the server is a failed read with no sqlstate', async () => {
    server = await fakePostgres({
      kind: 'error-on-query',
      sqlstate: 'X"0 0',
      message: SENTINEL,
    });

    const connection = await connectDatabase(settingsFor(server));
    try {
      expect(connection.marker).toStrictEqual({ kind: 'failed' });
      expect(decideIdentity(ANY_MARKER, connection.marker)).toStrictEqual({
        status: 'UNKNOWN',
        reason: 'unreadable',
      });
      expect(server.queries()).toBe(1);
    } finally {
      await connection.close();
    }
  });
});

describe('a marker row that is not a string (S0f)', () => {
  it.each<[string, number, string | null]>([
    ['an int4 column holding 7', 23, '7'],
    ['a NULL value', 25, null],
  ])(
    '%s: a failed read, UNKNOWN unreadable, no marker',
    async (_, oid, value) => {
      server = await fakePostgres({ kind: 'row-on-query', oid, value });

      const connection = await connectDatabase(settingsFor(server));
      try {
        expect(connection.marker).toStrictEqual({ kind: 'failed' });
        const identity = decideIdentity(ANY_MARKER, connection.marker);
        expect(identity).toStrictEqual({
          status: 'UNKNOWN',
          reason: 'unreadable',
        });
        expect(identity).not.toHaveProperty('marker');
        expect(server.queries()).toBe(1);
      } finally {
        await connection.close();
      }
    },
  );

  it('control: a text column holding a marker is read as that marker', async () => {
    server = await fakePostgres({
      kind: 'row-on-query',
      oid: 25,
      value: ANY_MARKER,
    });

    const connection = await connectDatabase(settingsFor(server));
    try {
      expect(connection.marker).toStrictEqual({
        kind: 'rows',
        markers: [ANY_MARKER],
      });
      expect(decideIdentity(ANY_MARKER, connection.marker)).toStrictEqual({
        status: 'VERIFIED',
        marker: ANY_MARKER,
      });
    } finally {
      await connection.close();
    }
  });
});
