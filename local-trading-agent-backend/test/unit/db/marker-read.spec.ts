import { parseSettings } from '../../../src/config/settings.js';
import {
  connectDatabase,
  MARKER_READ_TIMEOUT_MS,
} from '../../../src/db/client.js';
import { decideIdentity } from '../../../src/db/identity.js';
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
