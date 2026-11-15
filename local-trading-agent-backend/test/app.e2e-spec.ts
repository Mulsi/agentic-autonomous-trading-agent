import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  composeUrl,
  createTestDatabase,
  dropTestDatabase,
  newTestDatabaseName,
  runDbMigrate,
  testDatabaseUrl,
} from './fixtures/db.js';
import {
  FIXTURE_API_KEY,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
  UNPARSEABLE_DATABASE_URLS,
} from './fixtures/env.js';
import { expectClean, REDACTED } from './fixtures/logs.js';
import {
  countingListener,
  EXIT_LIMIT_MS,
  runMain,
  runNode,
  stdoutLines,
  type CountingListener,
  type MainResult as RunResult,
} from './fixtures/main.js';
import { appRoot } from './fixtures/repo.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A successful boot connects, so those cases run against a migrated throwaway
// database on the compose Postgres from `make db-up`. Its password is the
// fixed local-development one, and it must not appear in any output either.
const database = newTestDatabaseName();
const DATABASE_URL = testDatabaseUrl(database);
const LOADED_PASSWORD = new URL(DATABASE_URL).password;
const validEnv = { DATABASE_URL, TRADER_MODE: 'paper' };
let admin: Client;

/** A URL with the fixture password, at a loopback listener's port. */
function listenerUrl(listener: CountingListener): string {
  return `postgresql://trader:${FIXTURE_DB_PASSWORD}@127.0.0.1:${listener.port}/trader`;
}

beforeAll(async () => {
  if (!existsSync(join(appRoot, 'dist/main.js'))) {
    throw new Error('dist/main.js is missing. Run pnpm build first.');
  }
  admin = new Client({ connectionString: composeUrl('postgres') });
  await admin.connect();
  await createTestDatabase(admin, database);
  const migrated = await runDbMigrate(DATABASE_URL);
  if (migrated.code !== 0) throw new Error(`migrate: ${migrated.stderr}`);
});

afterAll(async () => {
  await dropTestDatabase(admin, database);
  await admin.end();
});

describe('node dist/main.js with valid env', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await runMain(validEnv);
  }, EXIT_LIMIT_MS + 5_000);

  it('exits 0 by itself within the limit', () => {
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('writes only JSON lines with level, msg and a UTC time', () => {
    const lines = stdoutLines(result);

    expect(lines.length).toBeGreaterThan(1);
    for (const raw of lines) {
      const line = JSON.parse(raw) as Record<string, unknown>;

      expect(line).toHaveProperty('level');
      expect(line).toHaveProperty('msg');
      expect(line.time).toMatch(ISO_UTC);
    }
  });

  it("routes Nest's own boot lines through pino", () => {
    const contexts = stdoutLines(result).map(
      (raw) => (JSON.parse(raw) as { context?: string }).context,
    );

    expect(contexts).toContain('NestFactory');
    expect(contexts).toContain('InstanceLoader');
  });

  it('logs one startup line with the mode and a UUID correlationId', () => {
    const startup = stdoutLines(result)
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((line) => line.mode !== undefined);

    expect(startup).toHaveLength(1);
    expect(startup[0]?.mode).toBe('paper');
    expect(startup[0]?.correlationId).toMatch(UUID);
  });

  it('writes neither fixture secret', () => {
    const output = result.stdout + result.stderr;

    expect(output).not.toContain(FIXTURE_API_KEY);
    expect(output).not.toContain(LOADED_PASSWORD);
    expect(output).not.toContain(DATABASE_URL);
  });
});

describe('node dist/main.js and ANTHROPIC_API_KEY (D9)', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await runMain({
      ...validEnv,
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    });
  }, EXIT_LIMIT_MS + 5_000);

  it('the valid env holds only DATABASE_URL and TRADER_MODE', () => {
    expect(Object.keys(fixtureEnv).sort()).toEqual([
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
    expect(Object.keys(validEnv).sort()).toEqual([
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
  });

  it('exits 0 by itself when the environment holds a key', () => {
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('writes the key to neither stdout nor stderr', () => {
    expect(result.stdout).not.toContain(FIXTURE_API_KEY);
    expect(result.stderr).not.toContain(FIXTURE_API_KEY);
  });
});

describe('node dist/main.js with invalid env', () => {
  // A listener at the URL's host and port: settings are checked before the
  // client connects, so it must see nothing.
  let listener: CountingListener;

  beforeEach(async () => {
    listener = await countingListener('close-at-once');
  });

  afterEach(async () => {
    await listener.close();
  });

  it.each(['live', 'testnet', 'PAPER'])(
    'refuses TRADER_MODE=%s without leaking secrets',
    async (mode) => {
      const result = await runMain({
        DATABASE_URL: listenerUrl(listener),
        TRADER_MODE: mode,
      });

      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain('TRADER_MODE');
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_API_KEY);
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_DB_PASSWORD);
      expect(listener.connections()).toBe(0);
    },
    EXIT_LIMIT_MS + 5_000,
  );

  it.each(['?sslmode=require', '#fragment'])(
    'refuses a DATABASE_URL ending in %s, before connecting (S0e round 2)',
    async (suffix) => {
      const result = await runMain({
        DATABASE_URL: listenerUrl(listener) + suffix,
        TRADER_MODE: 'paper',
      });

      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain('DATABASE_URL');
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_DB_PASSWORD);
      expect(result.stdout + result.stderr).not.toContain(suffix);
      expect(listener.connections()).toBe(0);
    },
    EXIT_LIMIT_MS + 5_000,
  );

  it(
    'refuses to start when TRADER_MODE is unset',
    async () => {
      const result = await runMain({ DATABASE_URL: listenerUrl(listener) });

      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stdout + result.stderr).not.toContain(FIXTURE_DB_PASSWORD);
      expect(listener.connections()).toBe(0);
    },
    EXIT_LIMIT_MS + 5_000,
  );
});

describe('node dist/main.js with an unparseable DATABASE_URL', () => {
  it.each(UNPARSEABLE_DATABASE_URLS)(
    'refuses %s without leaking the password',
    async (_, url) => {
      expect(() => new URL(url)).toThrow();

      const result = await runMain({ ...fixtureEnv, DATABASE_URL: url });

      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain('DATABASE_URL');
      expect(result.stdout).not.toContain(FIXTURE_DB_PASSWORD);
      expect(result.stderr).not.toContain(FIXTURE_DB_PASSWORD);
    },
    EXIT_LIMIT_MS + 5_000,
  );
});

describe('the built AppModule scrubs secret values from its logs', () => {
  // Boots dist/app.module.js as main.ts does, then logs one leaking shape from
  // each value-scrub case through the context's Logger. No test-only switch is
  // needed in production code.
  const PROBE = `
    const { NestFactory } = await import('@nestjs/core');
    const { Logger } = await import('nestjs-pino');
    const { AppModule } = await import('./dist/app.module.js');
    const { SETTINGS } = await import('./dist/config/config.module.js');

    const app = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      bufferLogs: true,
    });
    const logger = app.get(Logger);
    app.useLogger(logger);

    const settings = app.get(SETTINGS);
    const url = settings.DATABASE_URL;
    const password = new URL(url).password;

    logger.log({ msg: 'probe nested', a: { b: { c: settings } } }, 'Probe');
    logger.log({ msg: 'probe renamed', dsn: url, password }, 'Probe');
    logger.log('probe interpolated ' + url, 'Probe');
    logger.error(
      new Error('probe error ' + url, { cause: new Error('cause ' + password) }),
      'Probe',
    );

    await app.close();
  `;
  let result: RunResult;
  let lines: Record<string, unknown>[];

  beforeAll(async () => {
    result = await runNode(['--input-type=module', '--eval', PROBE], {
      ...validEnv,
    });
    // Lines that are not JSON fail the clean check below, not every test.
    lines = stdoutLines(result).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }, EXIT_LIMIT_MS + 5_000);

  it('exits 0 with nothing on stderr', () => {
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('writes only clean JSON lines to stdout', () => {
    expectClean(stdoutLines(result), [LOADED_PASSWORD, DATABASE_URL]);
  });

  it("passes Nest's buffered boot lines through the same logger", () => {
    const contexts = lines.map((line) => line.context);

    expect(contexts).toContain('InstanceLoader');
  });

  it('writes [REDACTED] where each secret was', () => {
    const probe = (msg: string) =>
      lines.find((line) => line.context === 'Probe' && line.msg === msg);

    expect(probe('probe nested')).toMatchObject({
      a: { b: { c: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' } } },
    });
    expect(probe('probe renamed')).toMatchObject({
      dsn: REDACTED,
      password: REDACTED,
    });
    expect(probe(`probe interpolated ${REDACTED}`)).toBeDefined();
    // pino's error serializer appends the cause's message to the error's.
    expect(probe(`probe error ${REDACTED}`)).toMatchObject({
      err: { message: `probe error ${REDACTED}: cause ${REDACTED}` },
    });
  });
});
