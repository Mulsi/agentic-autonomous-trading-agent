import { inspect } from 'node:util';
import { scrubSecrets, secretValues } from '../../../src/config/secrets.js';
import type { Settings } from '../../../src/config/settings.js';
import {
  FIXTURE_DATABASE_URL,
  FIXTURE_DB_PASSWORD,
  UNPARSEABLE_DATABASE_URLS,
} from '../../fixtures/env.js';
import { nonSpecSources, readAppFile } from '../../fixtures/repo.js';

const S = FIXTURE_DB_PASSWORD;

function settingsWith(url: string): Settings {
  return { DATABASE_URL: url, TRADER_MODE: 'paper' };
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

describe('secretValues', () => {
  it('returns the URL as loaded and the password for a plain password', () => {
    expect(secretValues(settingsWith(FIXTURE_DATABASE_URL))).toEqual([
      FIXTURE_DATABASE_URL,
      FIXTURE_DB_PASSWORD,
    ]);
  });

  it('returns every form of an encoded password, raw and JSON-escaped', () => {
    const url = `postgresql://trader:pw%22q%5Cs%40-${S}@localhost:5432/trader`;
    const normalized = `pw%22q%5Cs%40-${S}`;
    const decoded = `pw"q\\s@-${S}`;

    const values = secretValues(settingsWith(url));

    expect([...values].sort()).toEqual(
      [url, normalized, decoded, jsonEscaped(decoded)].sort(),
    );
  });

  it('uses the password as the URL parser normalizes it', () => {
    const url = `postgresql://trader:mix@d%20${S}@localhost:5432/trader`;

    expect(secretValues(settingsWith(url))).toEqual(
      expect.arrayContaining([url, `mix%40d%20${S}`, `mix@d ${S}`]),
    );
  });

  it('leaves out the decoded form when the password does not decode', () => {
    const url = `postgresql://trader:pa%zz-${S}@localhost:5432/trader`;
    expect(() => decodeURIComponent(`pa%zz-${S}`)).toThrow(URIError);

    expect(secretValues(settingsWith(url))).toEqual([url, `pa%zz-${S}`]);
  });

  it('JSON-escapes control characters in the decoded password', () => {
    const url = `postgresql://trader:tab%09${S}@localhost:5432/trader`;

    expect(secretValues(settingsWith(url))).toEqual(
      expect.arrayContaining([`tab\t${S}`, `tab\\t${S}`]),
    );
  });

  it('orders the values longest first, without duplicates', () => {
    const url = `postgresql://trader:pw%22q%5Cs%40-${S}@localhost:5432/trader`;
    const values = secretValues(settingsWith(url));
    const lengths = values.map((value) => value.length);

    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(new Set(values).size).toBe(values.length);
  });

  it.each([
    'postgresql://localhost/trader',
    'postgresql://trader@localhost/trader',
    'postgresql://trader:@localhost/trader',
  ])('returns no values for %s, which has no password', (url) => {
    expect(secretValues(settingsWith(url))).toEqual([]);
  });

  it('never returns the empty string', () => {
    const urls = [
      FIXTURE_DATABASE_URL,
      'postgresql://trader:@localhost/trader',
      `postgresql://trader:pa%zz-${S}@localhost:5432/trader`,
    ];

    for (const url of urls) {
      expect(secretValues(settingsWith(url))).not.toContain('');
    }
  });
});

describe('secretValues: unparseable DATABASE_URL', () => {
  function caught(url: string): Error {
    try {
      secretValues(settingsWith(url));
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('secretValues accepted an unparseable URL');
  }

  it.each(UNPARSEABLE_DATABASE_URLS)('%s makes new URL throw', (_, url) => {
    expect(() => new URL(url)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_URL', input: url }),
    );
  });

  it.each(UNPARSEABLE_DATABASE_URLS)(
    '%s: throws rather than returning no values',
    (_, url) => {
      expect(() => secretValues(settingsWith(url))).toThrow('DATABASE_URL');
    },
  );

  it.each(UNPARSEABLE_DATABASE_URLS)(
    '%s: the error has no input, no cause and no password',
    (_, url) => {
      const error = caught(url);

      expect(error).not.toHaveProperty('input');
      expect(error.cause).toBeUndefined();
      for (const text of [
        error.message,
        error.stack ?? '',
        inspect(error, { showHidden: true, depth: null }),
      ]) {
        expect(text).not.toContain(S);
      }
    },
  );
});

describe('scrubSecrets', () => {
  it('replaces every occurrence of every value', () => {
    expect(scrubSecrets('a1 b2 a1 c3 b2', ['a1', 'b2'])).toBe(
      '[REDACTED] [REDACTED] [REDACTED] c3 [REDACTED]',
    );
  });

  it('replaces the longest value first, whatever the order given', () => {
    const line = `connect ${FIXTURE_DATABASE_URL} with ${S}`;
    const expected = 'connect [REDACTED] with [REDACTED]';

    expect(scrubSecrets(line, [S, FIXTURE_DATABASE_URL])).toBe(expected);
    expect(scrubSecrets(line, [FIXTURE_DATABASE_URL, S])).toBe(expected);
  });

  it('returns the text unchanged when no value occurs', () => {
    expect(scrubSecrets('nothing here', [S])).toBe('nothing here');
  });

  it('returns the text unchanged for no values', () => {
    expect(scrubSecrets('nothing here', [])).toBe('nothing here');
  });

  it('never scrubs the empty string', () => {
    expect(scrubSecrets('nothing here', ['', S])).toBe('nothing here');
  });
});

describe('source checks', () => {
  it('secrets.ts imports nothing from Nest and never touches process', () => {
    const source = readAppFile('src/config/secrets.ts');

    expect(source).not.toContain('@nestjs/');
    expect(source).not.toContain('process.');
  });

  it('new URL( appears only in src/config/secrets.ts', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('new URL('))
      .map(({ path }) => path);

    expect(files).toEqual(['src/config/secrets.ts']);
  });

  it('process.env appears only in src/config/config.module.ts', () => {
    const files = nonSpecSources()
      .filter(({ text }) => text.includes('process.env'))
      .map(({ path }) => path);

    expect(files).toEqual(['src/config/config.module.ts']);
  });
});
