import { inspect } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module.js';
import { SETTINGS } from '../../../src/config/config.module.js';
import type { Settings } from '../../../src/config/settings.js';
import {
  FIXTURE_API_KEY,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
  stubFixtureEnv,
  UNPARSEABLE_DATABASE_URLS,
} from '../../fixtures/env.js';
import { readPackageJson } from '../../fixtures/repo.js';

async function settingsFromDi(): Promise<Settings> {
  const context = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: false,
  });

  try {
    return context.get<Settings>(SETTINGS);
  } finally {
    await context.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('importing the app module', () => {
  it('does not throw with an empty environment', async () => {
    for (const key of [...Object.keys(fixtureEnv), 'ANTHROPIC_API_KEY']) {
      vi.stubEnv(key, undefined);
    }
    vi.resetModules();

    await expect(import('../../../src/app.module.js')).resolves.toHaveProperty(
      'AppModule',
    );
  });
});

describe('ConfigModule', () => {
  it('returns the parsed settings through DI', async () => {
    stubFixtureEnv();
    vi.stubEnv('BINANCE_API_KEY', 'fixture-binance-key');

    const context = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });

    try {
      expect(context.get<Settings>(SETTINGS)).toEqual(fixtureEnv);
    } finally {
      await context.close();
    }
  });

  it('boots with only DATABASE_URL and TRADER_MODE set', async () => {
    stubFixtureEnv();

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(await settingsFromDi()).toEqual(fixtureEnv);
  });

  it('ignores ANTHROPIC_API_KEY in the environment (D9)', async () => {
    stubFixtureEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', FIXTURE_API_KEY);

    const settings = await settingsFromDi();

    expect(settings).toEqual(fixtureEnv);
    expect(JSON.stringify(settings)).not.toContain(FIXTURE_API_KEY);
  });

  it.each(UNPARSEABLE_DATABASE_URLS)(
    'refuses to boot on %s in DATABASE_URL without leaking it',
    async (_, url) => {
      stubFixtureEnv();
      vi.stubEnv('DATABASE_URL', url);

      const error: unknown = await NestFactory.createApplicationContext(
        AppModule,
        { abortOnError: false, logger: false },
      ).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('DATABASE_URL');
      expect(inspect(error, { showHidden: true, depth: null })).not.toContain(
        FIXTURE_DB_PASSWORD,
      );
    },
  );

  it('refuses to boot on invalid settings', async () => {
    stubFixtureEnv();
    vi.stubEnv('TRADER_MODE', 'testnet');

    await expect(
      NestFactory.createApplicationContext(AppModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toThrow('TRADER_MODE');
  });
});

describe('start scripts', () => {
  const start = Object.entries(readPackageJson().scripts).filter(([name]) =>
    name.startsWith('start'),
  );

  it('covers all four scaffold scripts', () => {
    expect(start.map(([name]) => name).sort()).toEqual([
      'start',
      'start:debug',
      'start:dev',
      'start:prod',
    ]);
  });

  it.each(start)('%s loads ../.env with the env-file option', (_, script) => {
    expect(script).toMatch(/--env-file[= ]\.\.\/\.env(\s|$)/);
  });
});
