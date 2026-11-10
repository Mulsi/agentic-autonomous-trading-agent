import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module.js';
import { connectDatabase } from '../../../src/db/client.js';
import {
  DATABASE,
  DATABASE_CONNECTION,
  IDENTITY,
} from '../../../src/db/db.module.js';
import type { DatabaseIdentity } from '../../../src/db/identity.js';
import {
  fakeConnection,
  FIXTURE_MARKER,
  type FakeConnection,
} from '../../fixtures/database.js';
import { fixtureEnv, stubFixtureEnv } from '../../fixtures/env.js';

// The DbModule wiring, booted through AppModule with no Postgres. The real
// providers run; only `connectDatabase` is replaced, by a spy, on the test side.
vi.mock(import('../../../src/db/client.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  connectDatabase: vi.fn(),
}));

let connection: FakeConnection;

async function boot(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [AppModule] }).compile();
}

beforeEach(() => {
  connection = fakeConnection();
  vi.mocked(connectDatabase).mockReset();
  vi.mocked(connectDatabase).mockImplementation(() =>
    Promise.resolve(connection),
  );
  stubFixtureEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DbModule', () => {
  it('connects once, with the parsed settings', async () => {
    const app = await boot();

    expect(vi.mocked(connectDatabase).mock.calls).toEqual([[fixtureEnv]]);
    await app.close();
  });

  it('provides the Drizzle instance of the connection', async () => {
    const app = await boot();

    expect(app.get(DATABASE)).toBe(connection.db);
    await app.close();
  });

  it.each<[string, string | undefined, DatabaseIdentity]>([
    [
      'unset',
      undefined,
      { status: 'UNKNOWN', reason: 'not_configured', marker: FIXTURE_MARKER },
    ],
    [
      'blank',
      '  ',
      { status: 'UNKNOWN', reason: 'not_configured', marker: FIXTURE_MARKER },
    ],
    [
      'another marker',
      'c4a1e2f3-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      { status: 'UNKNOWN', reason: 'mismatch', marker: FIXTURE_MARKER },
    ],
    [
      'the stored marker in upper case',
      FIXTURE_MARKER.toUpperCase(),
      { status: 'UNKNOWN', reason: 'mismatch', marker: FIXTURE_MARKER },
    ],
    [
      'the stored marker',
      FIXTURE_MARKER,
      { status: 'VERIFIED', marker: FIXTURE_MARKER },
    ],
  ])(
    'provides the identity when DATABASE_IDENTITY is %s',
    async (_, value, identity) => {
      vi.stubEnv('DATABASE_IDENTITY', value);
      const app = await boot();

      expect(app.get(IDENTITY)).toEqual(identity);
      await app.close();
    },
  );

  it('a missing marker is UNKNOWN and the boot still completes', async () => {
    vi.stubEnv('DATABASE_IDENTITY', FIXTURE_MARKER);
    connection = fakeConnection({ kind: 'no_table' });
    const app = await boot();

    expect(app.get(IDENTITY)).toEqual({
      status: 'UNKNOWN',
      reason: 'missing_marker',
    });
    await app.close();
  });

  it('an unreadable marker is UNKNOWN and the boot still completes', async () => {
    vi.stubEnv('DATABASE_IDENTITY', FIXTURE_MARKER);
    connection = fakeConnection({ kind: 'failed' });
    const app = await boot();

    expect(app.get(IDENTITY)).toEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
    });
    await app.close();
  });

  it('closing the context closes the connection', async () => {
    const app = await boot();
    expect(connection.closed()).toBe(0);

    await app.close();

    expect(connection.closed()).toBe(1);
  });

  it('a failed connect fails the boot, with no second attempt', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    vi.mocked(connectDatabase).mockImplementation(() =>
      Promise.reject(refused),
    );

    await expect(boot()).rejects.toThrow('ECONNREFUSED');
    expect(connectDatabase).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['TRADER_MODE', 'testnet'],
    ['TRADER_MODE', undefined],
    ['DATABASE_URL', 'postgresql://trader:x@localhost:99999/trader'],
  ])(
    'never connects when the settings are refused: %s=%s',
    async (key, value) => {
      vi.stubEnv(key, value);

      await expect(boot()).rejects.toThrow(key);
      expect(connectDatabase).not.toHaveBeenCalled();
    },
  );

  it('the provider can be substituted on the test side', async () => {
    const substitute = fakeConnection();
    const app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_CONNECTION)
      .useValue(substitute)
      .compile();

    expect(app.get(DATABASE)).toBe(substitute.db);
    expect(connectDatabase).not.toHaveBeenCalled();
    await app.close();
    expect(substitute.closed()).toBe(1);
  });
});
