import { userInfo } from 'node:os';
import fc from 'fast-check';
import pg from 'pg';
import { secretValues } from '../../../src/config/secrets.js';
import {
  parseSettings,
  SettingsError,
  type Settings,
} from '../../../src/config/settings.js';
import {
  APPLICATION_NAME,
  CONNECT_TIMEOUT_MS,
  databaseConfig,
  MARKER_READ_TIMEOUT_MS,
} from '../../../src/db/client.js';
import { databaseUrls } from '../../fixtures/database-urls.js';
import { FIXTURE_DB_PASSWORD, fixtureEnv } from '../../fixtures/env.js';
import { countingListener, EXIT_LIMIT_MS } from '../../fixtures/main.js';

// No connection is opened here: every pg.Client is built and inspected only.

const S = FIXTURE_DB_PASSWORD;

/** Every variable pg's JavaScript client reads, set to a sentinel. */
const PG_ENV = {
  PGHOST: 'pg-env-host-sentinel',
  PGPORT: '1999',
  PGUSER: 'pg-env-user-sentinel',
  PGPASSWORD: 'pg-env-password-sentinel',
  PGDATABASE: 'pg-env-database-sentinel',
  PGOPTIONS: '-c search_path=pg_env_sentinel',
  PGAPPNAME: 'pg-env-appname-sentinel',
  PGCLIENT_ENCODING: 'LATIN1',
  PGREPLICATION: 'database',
  PGSSLMODE: 'require',
  // Read with SSL off, this would make the constructor throw.
  PGSSLNEGOTIATION: 'direct',
  PGCONNECT_TIMEOUT: '97',
} as const;
const SENTINELS: readonly string[] = Object.values(PG_ENV);

interface Derived {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
  database: string;
  params: Record<string, unknown>;
}

/** What an unconnected pg.Client derives from the configuration. */
async function derived(settings: Settings): Promise<Derived> {
  const client = new pg.Client(databaseConfig(settings));
  const internals = client as unknown as {
    password: unknown;
    connectionParameters: Record<string, unknown>;
  };
  // The password is non-enumerable. When the URL has none, it is a function.
  const raw = internals.password;
  const password =
    typeof raw === 'function'
      ? ((await (raw as () => unknown)()) as string | undefined)
      : (raw as string | undefined);
  return {
    host: client.host,
    port: client.port,
    user: client.user ?? '',
    password,
    database: client.database ?? '',
    params: internals.connectionParameters,
  };
}

function settingsFor(url: string): Settings {
  return parseSettings({ DATABASE_URL: url, TRADER_MODE: 'paper' });
}

beforeEach(() => {
  for (const [key, value] of Object.entries(PG_ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('databaseConfig: the parameters come from DATABASE_URL alone', () => {
  it('the PG* sentinels are in the environment while these tests run', () => {
    expect(process.env.PGPASSWORD).toBe(PG_ENV.PGPASSWORD);
    // Control: pg reads them when the configuration leaves the fields out.
    const bare = new pg.Client({ ssl: false, sslnegotiation: 'postgres' });
    expect(bare.host).toBe(PG_ENV.PGHOST);
    expect(bare.user).toBe(PG_ENV.PGUSER);
  });

  it('takes host, port, user, password and database from the URL', async () => {
    const client = await derived(
      settingsFor(`postgresql://u:${S}@db.example:6543/name`),
    );

    expect(client).toMatchObject({
      host: 'db.example',
      port: 6543,
      user: 'u',
      password: S,
      database: 'name',
    });
  });

  it('uses port 5432 when the URL has no port', async () => {
    const client = await derived(
      settingsFor(`postgresql://u:${S}@db.example/name`),
    );

    expect(client.port).toBe(5432);
  });

  it.each([
    'postgresql://u@db.example:6543/name',
    'postgresql://u:@db.example:6543/name',
  ])('sends no PGPASSWORD for %s', async (url) => {
    const client = await derived(settingsFor(url));

    expect(client.password).not.toBe(PG_ENV.PGPASSWORD);
    expect(client.password).toBe('');
  });

  it('uses the operating-system user, not PGUSER, when the URL has none', async () => {
    const client = await derived(settingsFor('postgresql://db.example/name'));

    expect(client.user).toBe(userInfo().username);
  });

  it('names the database after the user, not PGDATABASE, when the URL has none', async () => {
    for (const url of [
      'postgresql://u@db.example',
      'postgresql://u@db.example/',
    ]) {
      expect((await derived(settingsFor(url))).database).toBe('u');
    }
  });

  it('keeps port 0 rather than reading PGPORT', async () => {
    const client = await derived(settingsFor('postgresql://u@db.example:0/n'));

    expect(client.port).toBe(0);
  });

  it('decodes the user and database, and unwraps a bracketed IPv6 host', async () => {
    const client = await derived(
      settingsFor('postgresql://us%40er@[::1]:6543/my%20db'),
    );

    expect(client).toMatchObject({
      host: '::1',
      user: 'us@er',
      database: 'my db',
    });
  });

  it('ignores the query string, so it cannot redirect the client', async () => {
    // parseSettings refuses this URL (S0e round 2). The client ignores a query
    // string anyway, as a second line of defence, so the settings are built
    // directly here.
    const url =
      'postgresql://u@db.example:6543/name?host=elsewhere&port=1&user=x&password=y&options=-c%20a%3Db';
    expect(() => settingsFor(url)).toThrow(SettingsError);
    const client = await derived({ DATABASE_URL: url, TRADER_MODE: 'paper' });

    expect(client).toMatchObject({
      host: 'db.example',
      port: 6543,
      user: 'u',
      database: 'name',
    });
    expect(client.password).toBe('');
  });

  it('reads none of the other PG* variables either', async () => {
    const { params } = await derived(
      settingsFor(`postgresql://u:${S}@db.example:6543/name`),
    );

    expect(params).toMatchObject({
      ssl: false,
      sslnegotiation: 'postgres',
      client_encoding: 'utf8',
      application_name: APPLICATION_NAME,
      replication: 'false',
      options: '-c TimeZone=UTC',
    });
    for (const value of Object.values(params)) {
      expect(SENTINELS).not.toContain(value);
    }
  });
});

describe('databaseConfig: boot behaviour', () => {
  const config = databaseConfig(
    settingsFor(`postgresql://u:${S}@db.example:6543/name`),
  );

  it('bounds the connect timeout well inside the e2e exit limit', () => {
    expect(config.connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(EXIT_LIMIT_MS / 2);
    expect(MARKER_READ_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('passes no connection string and no type parsers', () => {
    expect(config).not.toHaveProperty('connectionString');
    expect(config).not.toHaveProperty('types');
  });

  it('lets an idle pool never hold the process open', () => {
    expect(config.allowExitOnIdle).toBe(true);
  });
});

describe("the client's password is a scrubbed form (S0c review)", () => {
  it.each([
    [
      'escaped characters',
      `postgresql://trader:pw%22q%5Cs%40-${S}@localhost:5432/trader`,
      `pw"q\\s@-${S}`,
    ],
    [
      'mixed encoding',
      `postgresql://trader:mix@d%20${S}@localhost:5432/trader`,
      `mix@d ${S}`,
    ],
    [
      'a password that does not decode',
      `postgresql://trader:pa%zz-${S}@localhost:5432/trader`,
      `pa%zz-${S}`,
    ],
  ])('%s: the client sends one of the scrubbed forms', async (_, url, sent) => {
    const settings = settingsFor(url);
    const { password } = await derived(settings);

    expect(password).toBe(sent);
    expect(secretValues(settings)).toContain(password);
  });

  it('the counterexample: a valid and an invalid percent sequence together', async () => {
    const url = `postgresql://trader:a%20%zz-${S}@localhost:5432/trader`;
    const settings = settingsFor(url);

    // pg's own URL parser re-encodes this password before decoding it, and
    // gets a form the scrub does not know. That is why the client no longer
    // hands pg a connection string.
    const viaPg = new pg.Client({ connectionString: url }) as unknown as {
      password: string;
    };
    expect(viaPg.password).toBe(`a %zz-${S}`);
    expect(secretValues(settings)).not.toContain(viaPg.password);

    const { password } = await derived(settings);
    expect(password).toBe(`a%20%zz-${S}`);
    expect(secretValues(settings)).toContain(password);
  });

  it('pg would throw on a URL the settings accept; the client does not', () => {
    const url = `postgresql://trader:x%C3-${S}@localhost:5432/trader`;
    const settings = settingsFor(url);

    expect(() => new pg.Client({ connectionString: url })).toThrow(URIError);
    expect(() => new pg.Client(databaseConfig(settings))).not.toThrow();
  });

  it('holds for every DATABASE_URL that parseSettings accepts (2,000 runs)', async () => {
    let accepted = 0;
    let withPassword = 0;

    await fc.assert(
      fc.asyncProperty(databaseUrls, async ({ value }) => {
        let settings: Settings;
        try {
          settings = settingsFor(value);
        } catch (error) {
          if (error instanceof SettingsError) return;
          throw error;
        }
        accepted += 1;

        // Throws fail the property: building must never refuse a valid URL.
        const client = await derived(settings);
        const values = secretValues(settings);

        const url = new URL(settings.DATABASE_URL);
        expect(client.port).toBe(url.port === '' ? 5432 : Number(url.port));
        if (url.password === '') {
          expect(values).toEqual([]);
          expect(client.password).toBe('');
        } else {
          withPassword += 1;
          expect(client.password).not.toBe('');
          expect(values).toContain(client.password);
        }
        expect(client.host).not.toBe(PG_ENV.PGHOST);
        expect(client.user).not.toBe(PG_ENV.PGUSER);
        expect(client.database).not.toBe(PG_ENV.PGDATABASE);
      }),
      { numRuns: 2_000 },
    );

    expect(accepted).toBeGreaterThan(500);
    expect(withPassword).toBeGreaterThan(100);
  });
});

describe('importing src/app.module.ts', () => {
  it('does not throw with an empty environment, and opens no connection', async () => {
    const listener = await countingListener('close-at-once');
    try {
      for (const key of [
        ...Object.keys(fixtureEnv),
        'DATABASE_IDENTITY',
        'ANTHROPIC_API_KEY',
      ]) {
        vi.stubEnv(key, undefined);
      }
      // A connection opened at import, with no configuration, would land here.
      vi.stubEnv('PGHOST', '127.0.0.1');
      vi.stubEnv('PGPORT', String(listener.port));
      vi.resetModules();

      await expect(
        import('../../../src/app.module.js'),
      ).resolves.toHaveProperty('AppModule');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(listener.connections()).toBe(0);
    } finally {
      await listener.close();
    }
  });
});
