import { inspect } from 'node:util';
import {
  parseSettings,
  SettingsError,
  settingsSchema,
  type Settings,
} from '../../../src/config/settings.js';
import {
  FIXTURE_API_KEY,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
  UNPARSEABLE_DATABASE_URLS,
} from '../../fixtures/env.js';
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

function without(key: string): Env {
  const env: Env = { ...fixtureEnv };
  delete env[key];
  return env;
}

describe('parseSettings: valid input', () => {
  it('returns exactly DATABASE_URL and TRADER_MODE', () => {
    const settings = parseSettings(fixtureEnv);

    expect(Object.keys(settings).sort()).toEqual([
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
    expect(Object.keys(settingsSchema.shape).sort()).toEqual([
      'DATABASE_URL',
      'TRADER_MODE',
    ]);
    expect(settings).toEqual(fixtureEnv);
  });

  it('types the settings as exactly the two keys', () => {
    expectTypeOf<keyof Settings>().toEqualTypeOf<
      'DATABASE_URL' | 'TRADER_MODE'
    >();
  });

  it('drops every other variable', () => {
    const settings = parseSettings({
      ...fixtureEnv,
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
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

describe('parseSettings: ANTHROPIC_API_KEY is not a setting (D9)', () => {
  const expected = parseSettings(fixtureEnv);

  it.each([
    ['unset', without('ANTHROPIC_API_KEY')],
    ['empty', { ...fixtureEnv, ANTHROPIC_API_KEY: '' }],
    ['whitespace-only', { ...fixtureEnv, ANTHROPIC_API_KEY: '   \t\n' }],
    ['a sentinel', { ...fixtureEnv, ANTHROPIC_API_KEY: FIXTURE_API_KEY }],
  ])('succeeds and drops it when it is %s', (_, env) => {
    const settings = parseSettings(env);

    expect(settings).toEqual(expected);
    expect(settings).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.stringify(settings)).not.toContain(FIXTURE_API_KEY);
  });

  it('never reads it', () => {
    const reads: string[] = [];
    const env = new Proxy<Env>(
      { ...fixtureEnv, ANTHROPIC_API_KEY: FIXTURE_API_KEY },
      {
        get(target, key, receiver) {
          reads.push(String(key));
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );

    parseSettings(env);

    expect(reads).not.toContain('ANTHROPIC_API_KEY');
  });
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
    // A blank ANTHROPIC_API_KEY is no longer an error (D9), so it is not named.
    const error = caught({ ANTHROPIC_API_KEY: ' ', DATABASE_URL: MODE });

    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('TRADER_MODE');
    expect(error.message).not.toContain('ANTHROPIC_API_KEY');
    expect(error.invalidKeys).toEqual(['DATABASE_URL', 'TRADER_MODE']);
  });

  it('does not name a key that is valid', () => {
    const error = caught({ ...fixtureEnv, TRADER_MODE: MODE });

    expect(error.message).not.toContain('ANTHROPIC_API_KEY');
    expect(error.message).not.toContain('DATABASE_URL');
  });
});

describe('parseSettings: unparseable DATABASE_URL', () => {
  // Node's ERR_INVALID_URL carries the whole URL in its `input` property, and
  // Node's printer for uncaught errors shows it. zod parses with `new URL`, and
  // parseSettings must discard that error along with zod's own.
  function caught(url: string): SettingsError {
    try {
      parseSettings({ ...fixtureEnv, DATABASE_URL: url });
    } catch (error) {
      if (error instanceof SettingsError) return error;
      throw error;
    }
    throw new Error('parseSettings accepted an unparseable URL');
  }

  it.each(UNPARSEABLE_DATABASE_URLS)('%s makes new URL throw', (_, url) => {
    expect(() => new URL(url)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_URL', input: url }),
    );
  });

  it.each(UNPARSEABLE_DATABASE_URLS)(
    '%s: throws a SettingsError that names only DATABASE_URL',
    (_, url) => {
      const error = caught(url);

      expect(error.invalidKeys).toEqual(['DATABASE_URL']);
      expect(error.cause).toBeUndefined();
      expect(error).not.toHaveProperty('input');
    },
  );

  it.each(UNPARSEABLE_DATABASE_URLS)(
    '%s: keeps the password out of every error surface',
    (_, url) => {
      const error = caught(url);
      const surfaces = [
        error.message,
        error.stack ?? '',
        JSON.stringify(error),
        inspect(error, { showHidden: true, depth: null }),
      ];

      for (const text of surfaces) {
        expect(text).not.toContain(FIXTURE_DB_PASSWORD);
      }
    },
  );
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
