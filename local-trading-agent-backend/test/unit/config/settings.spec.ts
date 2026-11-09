import {
  parseSettings,
  SettingsError,
  type Settings,
} from '../../../src/config/settings.js';
import { fixtureEnv } from '../../fixtures/env.js';
import { listAppFiles, readAppFile } from '../../fixtures/repo.js';

type Env = Record<string, string | undefined>;

function invalidKeysFor(env: Env): readonly string[] {
  try {
    parseSettings(env);
  } catch (error) {
    if (error instanceof SettingsError) return error.invalidKeys;
    throw error;
  }
  throw new Error('parseSettings accepted invalid input');
}

function without(key: keyof typeof fixtureEnv): Env {
  const env: Env = { ...fixtureEnv };
  delete env[key];
  return env;
}

describe('parseSettings: valid input', () => {
  it('returns exactly the three keys', () => {
    const settings = parseSettings(fixtureEnv);

    expect(Object.keys(settings).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
    expect(settings).toEqual(fixtureEnv);
  });

  it('drops every other variable', () => {
    const settings = parseSettings({
      ...fixtureEnv,
      BINANCE_API_KEY: 'fixture-binance-key',
      HOME: '/home/fixture',
      PORT: '3000',
    });

    expect(settings).toEqual(fixtureEnv);
  });
});

describe('parseSettings: TRADER_MODE', () => {
  it.each([
    'live',
    'LIVE',
    'Paper',
    'PAPER',
    'testnet',
    'shadow',
    ' paper',
    '',
  ])('rejects %j', (mode) => {
    expect(invalidKeysFor({ ...fixtureEnv, TRADER_MODE: mode })).toEqual([
      'TRADER_MODE',
    ]);
  });

  it('rejects unset, so there is no default', () => {
    expect(invalidKeysFor(without('TRADER_MODE'))).toEqual(['TRADER_MODE']);
  });

  it('types the mode as exactly the paper literal', () => {
    expectTypeOf<Settings['TRADER_MODE']>().toEqualTypeOf<'paper'>();
  });

  it('never names another mode in settings.ts', () => {
    expect(readAppFile('src/config/settings.ts')).not.toMatch(/live/i);
  });
});

describe('parseSettings: ANTHROPIC_API_KEY', () => {
  it('rejects unset', () => {
    expect(invalidKeysFor(without('ANTHROPIC_API_KEY'))).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
  });

  it.each(['', ' ', '   \t\n'])('rejects blank value %j', (key) => {
    expect(invalidKeysFor({ ...fixtureEnv, ANTHROPIC_API_KEY: key })).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
  });

  it.each(['x', 'any-opaque-value', 'no format check at all'])(
    'applies no format or prefix check to %j',
    (key) => {
      const env = { ...fixtureEnv, ANTHROPIC_API_KEY: key };

      expect(parseSettings(env).ANTHROPIC_API_KEY).toBe(key);
    },
  );
});

describe('parseSettings: DATABASE_URL', () => {
  it.each([
    'postgres://trader:secret@localhost:5432/trader',
    'postgresql://trader:secret@localhost:5432/trader',
    'postgresql://localhost/trader',
  ])('accepts %s', (url) => {
    const env = { ...fixtureEnv, DATABASE_URL: url };

    expect(parseSettings(env).DATABASE_URL).toBe(url);
  });

  it('rejects unset', () => {
    expect(invalidKeysFor(without('DATABASE_URL'))).toEqual(['DATABASE_URL']);
  });

  it.each([
    '',
    'not a url',
    'localhost:5432/trader',
    'postgres://',
    'postgres:trader',
    'mysql://trader:secret@localhost:3306/trader',
    'postgresql+asyncpg://trader:secret@localhost:5432/trader',
  ])('rejects %j', (url) => {
    expect(invalidKeysFor({ ...fixtureEnv, DATABASE_URL: url })).toEqual([
      'DATABASE_URL',
    ]);
  });
});

describe('parseSettings: errors never carry values', () => {
  const API_KEY = 'sentinel-api-key-c41d';
  const DB_PASSWORD = 'sentinel-db-password-e07a';
  const MODE = 'sentinel-mode-5b2f';
  const SENTINELS = [API_KEY, DB_PASSWORD, MODE];

  function caught(env: Env): SettingsError {
    try {
      parseSettings(env);
    } catch (error) {
      if (error instanceof SettingsError) return error;
      throw error;
    }
    throw new Error('parseSettings accepted invalid input');
  }

  it.each(['message', 'stack', 'JSON.stringify output'])(
    'keeps sentinels out of the %s',
    (surface) => {
      const error = caught({
        ANTHROPIC_API_KEY: API_KEY,
        DATABASE_URL: `mysql://trader:${DB_PASSWORD}@localhost:3306/trader`,
        TRADER_MODE: MODE,
      });
      const text = {
        message: error.message,
        stack: error.stack ?? '',
        'JSON.stringify output': JSON.stringify(error),
      }[surface];

      for (const sentinel of SENTINELS) {
        expect(text).not.toContain(sentinel);
      }
    },
  );

  it('attaches neither the input nor the zod error', () => {
    const error = caught({
      ANTHROPIC_API_KEY: API_KEY,
      DATABASE_URL: DB_PASSWORD,
      TRADER_MODE: MODE,
    });

    expect(error.cause).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(['invalidKeys', 'name']);
  });

  it('names every invalid key in the message', () => {
    const error = caught({ ANTHROPIC_API_KEY: ' ', DATABASE_URL: MODE });

    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('TRADER_MODE');
    expect(error.invalidKeys).toEqual([
      'ANTHROPIC_API_KEY',
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
  });

  it('does not name a key that is valid', () => {
    const error = caught({ ...fixtureEnv, TRADER_MODE: MODE });

    expect(error.message).not.toContain('ANTHROPIC_API_KEY');
    expect(error.message).not.toContain('DATABASE_URL');
  });
});

describe('parseSettings: purity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads only its argument', () => {
    for (const [key, value] of Object.entries(fixtureEnv)) {
      vi.stubEnv(key, value);
    }

    expect(() => parseSettings({})).toThrow(SettingsError);
  });

  it('settings.ts has no Nest import and never touches process', () => {
    const source = readAppFile('src/config/settings.ts');

    expect(source).not.toContain('@nestjs/');
    expect(source).not.toContain('process.');
  });

  it('src never opens an env file itself', () => {
    const offenders = listAppFiles('src').filter((path) =>
      /dotenv|loadEnvFile/.test(readAppFile(path)),
    );

    expect(offenders).toEqual([]);
  });
});
