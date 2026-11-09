import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module.js';
import { SETTINGS } from '../../../src/config/config.module.js';
import type { Settings } from '../../../src/config/settings.js';
import { fixtureEnv, stubFixtureEnv } from '../../fixtures/env.js';
import { readPackageJson } from '../../fixtures/repo.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('importing the app module', () => {
  it('does not throw with an empty environment', async () => {
    for (const key of Object.keys(fixtureEnv)) {
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
