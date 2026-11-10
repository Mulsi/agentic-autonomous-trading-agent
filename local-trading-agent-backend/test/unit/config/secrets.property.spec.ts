import fc from 'fast-check';
import { loggerOptions } from '../../../src/config/logging.js';
import { secretValues } from '../../../src/config/secrets.js';
import {
  parseSettings,
  SettingsError,
  type Settings,
} from '../../../src/config/settings.js';
import {
  databaseUrls,
  UNPARSEABLE_SHAPES,
  type UrlShape,
} from '../../fixtures/database-urls.js';

// Boot availability (S0c review, D11). AppModule runs
// `loggerOptions(secretValues(settings))` on the settings `parseSettings`
// returned. A DATABASE_URL that the settings accept must never make that throw,
// or a valid setting refuses the boot. Today this holds because zod's URL rule
// runs the same WHATWG parser that `secretValues` does; the property keeps it
// true across zod upgrades.

const RUNS = 2_000;

/** The settings for `value`, or undefined when `parseSettings` refuses it. */
function settingsFor(value: string): Settings | undefined {
  try {
    return parseSettings({ DATABASE_URL: value, TRADER_MODE: 'paper' });
  } catch (error) {
    // A refusal is a SettingsError. Anything else fails the test.
    if (error instanceof SettingsError) return undefined;
    throw error;
  }
}

/** C0 controls and space: what the WHATWG parser strips at the edges. */
function isC0OrSpace(character: string | undefined): boolean {
  return character !== undefined && character.charCodeAt(0) <= 0x20;
}

/** A character that either trim can remove at an edge. */
function isEdgeWhitespace(character: string | undefined): boolean {
  return isC0OrSpace(character) || /\s/.test(character ?? '');
}

/** The leading and trailing runs of edge whitespace in `value`. */
function edgeRuns(value: string): [string, string] {
  let start = 0;
  while (start < value.length && isEdgeWhitespace(value[start])) start += 1;
  let end = value.length;
  while (end > start && isEdgeWhitespace(value[end - 1])) end -= 1;
  return [value.slice(0, start), value.slice(end)];
}

describe('secretValues on every DATABASE_URL that parseSettings accepts', () => {
  it(`neither secretValues nor the logger options throw (${RUNS} runs)`, () => {
    let runs = 0;
    let accepted = 0;

    fc.assert(
      fc.property(databaseUrls, ({ value }) => {
        runs += 1;
        const settings = settingsFor(value);
        if (settings === undefined) return;
        accepted += 1;

        // Exactly what AppModule's logger factory runs at boot.
        loggerOptions(secretValues(settings));
      }),
      { numRuns: RUNS },
    );

    expect(runs).toBeGreaterThanOrEqual(1_000);
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('the DATABASE_URL generator reaches the boundary', () => {
  const values = fc.sample(databaseUrls, RUNS);
  const passing = values.flatMap((generated) => {
    const settings = settingsFor(generated.value);
    return settings === undefined ? [] : [{ ...generated, settings }];
  });
  const failing = values.filter(
    ({ value }) => settingsFor(value) === undefined,
  );

  /** The URL that `secretValues` parses, for a passing value. */
  const parsed = (settings: Settings): URL => new URL(settings.DATABASE_URL);

  // Each check confirms the shape on the passing value itself, so a wrong label
  // cannot make the coverage look better than it is.
  const passingShapes: [UrlShape, (value: string, url: URL) => boolean][] = [
    [
      'edge ASCII whitespace or C0 control',
      (value) => isC0OrSpace(value.at(0)) || isC0OrSpace(value.at(-1)),
    ],
    [
      'edge U+00A0 or U+FEFF',
      (value) =>
        edgeRuns(value).some(
          (run) => run.includes('\u00a0') || run.includes('\ufeff'),
        ),
    ],
    [
      'tab, LF or CR inside',
      (value) => {
        const [leading, trailing] = edgeRuns(value);
        const inner = value.slice(
          leading.length,
          value.length - trailing.length,
        );
        return /[\t\n\r]/.test(inner);
      },
    ],
    [
      'percent-encoded password',
      (_, url) => /%[0-9A-Fa-f]{2}/.test(url.password),
    ],
    [
      'invalid percent sequence in password',
      (_, url) => /%(?![0-9A-Fa-f]{2})/.test(url.password),
    ],
    ['raw @ in password', (_, url) => url.password.includes('%40')],
    [
      'non-ASCII password',
      (_, url) => /%[89A-Fa-f][0-9A-Fa-f]/.test(url.password),
    ],
    ['bracketed IPv6 host', (_, url) => url.hostname.startsWith('[')],
    ['non-ASCII host', (_, url) => url.hostname.includes('%')],
    ['explicit port', (_, url) => url.port !== ''],
    ['scheme postgres', (_, url) => url.protocol === 'postgres:'],
    ['scheme postgresql', (_, url) => url.protocol === 'postgresql:'],
    [
      'upper-case scheme',
      (value) => /[A-Z]/.test(value.slice(0, value.indexOf(':'))),
    ],
  ];

  it(`draws ${RUNS} values, at least 1,000`, () => {
    expect(values.length).toBeGreaterThanOrEqual(1_000);
  });

  it('a quarter or more of them pass parseSettings', () => {
    expect(passing.length).toBeGreaterThanOrEqual(values.length / 4);
  });

  it('some passing value has a non-empty password', () => {
    expect(
      passing.some(({ settings }) => parsed(settings).password !== ''),
    ).toBe(true);
  });

  it('some value fails parseSettings', () => {
    expect(failing.length).toBeGreaterThan(0);
  });

  it.each(passingShapes)(
    'the shape "%s" occurs among the passing values, and holds for each',
    (shape, holds) => {
      const hits = passing.filter(({ shapes }) => shapes.includes(shape));

      expect(hits.length).toBeGreaterThan(0);
      for (const { value, settings } of hits) {
        expect(holds(value, parsed(settings)), JSON.stringify(value)).toBe(
          true,
        );
      }
    },
  );

  it.each(UNPARSEABLE_SHAPES)(
    'the UNPARSEABLE_DATABASE_URLS shape "%s" occurs, and always fails',
    (shape) => {
      const hits = values.filter(({ shapes }) => shapes.includes(shape));

      expect(hits.length).toBeGreaterThan(0);
      for (const { value } of hits) {
        expect(settingsFor(value), JSON.stringify(value)).toBeUndefined();
      }
    },
  );

  it('fully random strings are part of the mix', () => {
    const random = values.filter(({ shapes }) => shapes.includes('random'));

    expect(random.length).toBeGreaterThan(0);
  });
});
