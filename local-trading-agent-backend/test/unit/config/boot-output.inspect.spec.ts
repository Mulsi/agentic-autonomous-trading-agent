import { inspect } from 'node:util';
import fc from 'fast-check';
import {
  BootConsoleLogger,
  printBootFailure,
  recordBootSecrets,
  scrubbedForInspect,
} from '../../../src/config/boot-output.js';
import { secretValues } from '../../../src/config/secrets.js';
import {
  parseSettings,
  SettingsError,
  type Settings,
} from '../../../src/config/settings.js';
import { REDACTED } from '../../fixtures/logs.js';
import { readAppFile } from '../../fixtures/repo.js';

// S0f: both failed-boot printers turn values into text with util.inspect, which
// escapes quotes and control characters its own way and splits a long string
// at `\n`. The value scrub must still leave no form of a recorded secret.

/** Alphanumeric, so inspect never escapes or splits it. */
const CORE = 'CORESENTINEL7Q2X9';

/** Captures what is written to stdout and stderr while `body` runs. */
function captured(body: () => void): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  const err = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
  try {
    body();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return { stdout, stderr };
}

function urlFor(password: string): string {
  return `postgresql://trader:${encodeURIComponent(password)}@localhost:5432/trader`;
}

/** The settings for `password`, or undefined when parseSettings refuses it. */
function settingsFor(password: string): Settings | undefined {
  try {
    return parseSettings({
      DATABASE_URL: urlFor(password),
      TRADER_MODE: 'paper',
    });
  } catch (error) {
    if (error instanceof SettingsError) return undefined;
    throw error;
  }
}

/** The three forms a value can hold: decoded, `url.password`, the URL. */
function formsOf(password: string, settings: Settings): [string, string][] {
  return [
    ['the decoded password', password],
    ['url.password', new URL(settings.DATABASE_URL).password],
    ['the URL as loaded', settings.DATABASE_URL],
  ];
}

/** An error holding `value` in one place, for each place the spec names. */
function placements(value: string): [string, () => unknown][] {
  const error = (props: Record<string, unknown>): Error =>
    Object.assign(new Error('boot failed'), { code: '28P01' }, props);
  return [
    ['an own property', () => error({ secret: value })],
    ['embedded in text', () => error({ detail: `user said ${value} here` })],
    ['nested at depth 2', () => error({ outer: { inner: value } })],
    ['nested at depth 3', () => error({ a: { b: { c: value } } })],
    ['an array element', () => error({ list: ['x', value, 'y'] })],
    [
      'a property of its cause',
      () =>
        new Error('boot failed', {
          cause: Object.assign(new Error('inner'), { secret: value }),
        }),
    ],
    [
      'an AggregateError entry',
      () =>
        new AggregateError(
          [
            new Error('first'),
            Object.assign(new Error('x'), { secret: value }),
          ],
          'many failed',
        ),
    ],
    ['a Map value', () => error({ map: new Map([['password', value]]) })],
  ];
}

/** Passwords `prefix + CORE + suffix`, with quotes, controls and non-ASCII. */
const affix = fc.string({
  unit: fc.oneof(
    fc.constantFrom("'", '"', '`', '\\', '\n', '\r', '\t', '\u007f', 'é', '€'),
    fc.integer({ min: 0, max: 0x1f }).map((code) => String.fromCharCode(code)),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
  ),
  maxLength: 60,
});
const passwords = fc
  .tuple(affix, affix)
  .map(([prefix, suffix]) => `${prefix}${CORE}${suffix}`);

const savedExitCode = process.exitCode;

afterEach(() => {
  recordBootSecrets([]);
  process.exitCode = savedExitCode;
});

describe('printBootFailure leaves no form of a secret (property)', () => {
  it('prints no CORE, whatever value holds the password (300 runs)', () => {
    let accepted = 0;
    fc.assert(
      fc.property(passwords, (password) => {
        const settings = settingsFor(password);
        if (settings === undefined) return;
        accepted += 1;
        recordBootSecrets(secretValues(settings));

        for (const [form, value] of formsOf(password, settings)) {
          for (const [place, make] of placements(value)) {
            const { stderr } = captured(() => printBootFailure(make()));

            expect(stderr, `${form}, ${place}`).not.toContain(CORE);
            expect(stderr, `${form}, ${place}`).toContain(REDACTED);
          }
        }
      }),
      { numRuns: 300 },
    );
    expect(accepted).toBeGreaterThan(250);
  });

  it('control: with no recorded secrets the same errors print CORE (300 runs)', () => {
    fc.assert(
      fc.property(passwords, (password) => {
        const settings = settingsFor(password);
        if (settings === undefined) return;
        recordBootSecrets([]);

        for (const [form, value] of formsOf(password, settings)) {
          for (const [place, make] of placements(value)) {
            const { stderr } = captured(() => printBootFailure(make()));

            expect(stderr, `${form}, ${place}`).toContain(CORE);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("the reviewer's probe: a'b\"c`d\\x07e", () => {
  const password = 'a\'b"c`d\x07e';
  const settings = settingsFor(password);
  const escaped = inspect(password).slice(1, -1);
  const leaking = (): Error =>
    Object.assign(new Error('boot failed'), { secret: password });

  it('inspect really escapes it into a form the recorded values lack', () => {
    expect(settings).toBeDefined();
    expect(escaped).toBe('a\\\'b"c`d\\x07e');
    expect(secretValues(settings as Settings)).not.toContain(escaped);
  });

  it('prints neither the raw, the JSON-escaped nor the inspect-escaped form', () => {
    recordBootSecrets(secretValues(settings as Settings));

    const { stderr } = captured(() => printBootFailure(leaking()));

    expect(stderr).not.toContain(password);
    expect(stderr).not.toContain(JSON.stringify(password).slice(1, -1));
    expect(stderr).not.toContain(escaped);
    expect(stderr).toContain(`secret: '${REDACTED}'`);
  });

  it('control: with no recorded secrets the inspect-escaped form is printed', () => {
    const { stderr } = captured(() => printBootFailure(leaking()));

    expect(stderr).toContain(escaped);
  });
});

describe('a long password that inspect splits at its newline', () => {
  const first = `FIRSTHALF${'a'.repeat(40)}`;
  const second = `SECONDHALF${'b'.repeat(40)}`;
  const password = `${first}\n${second}`;
  const leaking = (): Error =>
    Object.assign(new Error('boot failed'), {
      nested: { holder: { value: password } },
    });

  it('is longer than 80 characters', () => {
    expect(password.length).toBeGreaterThan(80);
  });

  it('neither half is printed', () => {
    const settings = settingsFor(password);
    expect(settings).toBeDefined();
    recordBootSecrets(secretValues(settings as Settings));

    const { stderr } = captured(() => printBootFailure(leaking()));

    expect(stderr).not.toContain(first);
    expect(stderr).not.toContain(second);
  });

  it('control: inspect splits it, so both halves appear on separate lines', () => {
    const { stderr } = captured(() => printBootFailure(leaking()));
    const lines = stderr.split('\n');
    const at = (half: string): number =>
      lines.findIndex((line) => line.includes(half));

    expect(at(first)).toBeGreaterThanOrEqual(0);
    expect(at(second)).toBeGreaterThan(at(first));
    // The escaped form is not one contiguous piece of text either.
    expect(stderr).not.toContain(`${first}\\n${second}`);
  });
});

describe('BootConsoleLogger leaves no form of a secret (property)', () => {
  const printed = (value: string): string => {
    const logger = new BootConsoleLogger();
    const error = Object.assign(new Error('boot failed'), { secret: value });
    const { stdout, stderr } = captured(() => {
      logger.error(error);
      logger.log({ outer: { inner: value } });
    });
    return stdout + stderr;
  };

  it('logger.error(error) and logger.log(object) print no CORE (60 runs)', () => {
    fc.assert(
      fc.property(passwords, (password) => {
        const settings = settingsFor(password);
        if (settings === undefined) return;
        recordBootSecrets(secretValues(settings));

        for (const [form, value] of formsOf(password, settings)) {
          expect(printed(value), form).not.toContain(CORE);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('control: with no recorded secrets they print CORE (60 runs)', () => {
    fc.assert(
      fc.property(passwords, (password) => {
        const settings = settingsFor(password);
        if (settings === undefined) return;
        recordBootSecrets([]);

        for (const [form, value] of formsOf(password, settings)) {
          expect(printed(value), form).toContain(CORE);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('params are scrubbed before inspect too', () => {
    const password = 'a\'b"c`d\x07e';
    recordBootSecrets(secretValues(settingsFor(password) as Settings));
    const logger = new BootConsoleLogger();

    const { stdout } = captured(() =>
      logger.log('message', { params: { value: password } }, 'Context'),
    );

    expect(stdout).toContain('message');
    expect(stdout).not.toContain(inspect(password).slice(1, -1));
    expect(stdout).not.toContain(password);
  });
});

describe('nothing else changes', () => {
  const password = 'plain-password-sentinel-4c1a';
  const record = (): void => {
    recordBootSecrets(secretValues(settingsFor(password) as Settings));
  };

  class DriverError extends Error {
    override name = 'DriverError';
  }

  it('printBootFailure still sets process.exitCode = 1', () => {
    record();
    process.exitCode = 0;

    captured(() => printBootFailure(new Error('x')));

    expect(process.exitCode).toBe(1);
  });

  it('prints the class name, the code and a non-secret property unchanged', () => {
    record();
    const error = Object.assign(new DriverError('auth failed'), {
      code: '28P01',
      severity: 'FATAL',
      secret: password,
    });

    const { stderr } = captured(() => printBootFailure(error));

    expect(stderr).toMatch(/^DriverError: auth failed/);
    expect(stderr).toContain("code: '28P01'");
    expect(stderr).toContain("severity: 'FATAL'");
    expect(stderr).toContain(`secret: '${REDACTED}'`);
    expect(stderr).not.toContain(password);
  });

  it('a circular reference prints without throwing', () => {
    record();
    const error = Object.assign(new Error('loop'), {
      secret: password,
    }) as Error & { self?: unknown; holder?: unknown };
    error.self = error;
    const holder: Record<string, unknown> = { password };
    holder.again = holder;
    error.holder = holder;

    const { stderr } = captured(() => printBootFailure(error));

    expect(stderr).toContain('[Circular');
    expect(stderr).not.toContain(password);
  });

  it('with no secret in it, the copy inspects exactly like the original', () => {
    const error = Object.assign(new DriverError('auth failed'), {
      code: '28P01',
      list: [1, 'two', { three: 3n }],
      map: new Map<unknown, unknown>([['k', new Set(['v'])]]),
      when: new Date(0),
      pattern: /x/g,
      bytes: Buffer.from('ab'),
      nothing: null,
      fn: function named() {
        return undefined;
      },
    });
    error.stack = 'DriverError: auth failed\n    at fixture (fixture.ts:1:1)';
    const options = { depth: 4 };

    expect(inspect(scrubbedForInspect(error, ['not-in-there']), options)).toBe(
      inspect(error, options),
    );
  });

  it('getters are copied, never called', () => {
    let calls = 0;
    const value = {
      get password(): string {
        calls += 1;
        return 'x';
      },
    };

    const copy = scrubbedForInspect(value, ['secret']);

    expect(calls).toBe(0);
    expect(inspect(copy)).toBe(inspect(value));
  });

  it('with no recorded secrets the value itself is returned', () => {
    const value = { a: 1 };

    expect(scrubbedForInspect(value, [])).toBe(value);
  });
});

// S0g: the doc comment said getters are never called. One is: an Error's own
// `stack`, even a user-defined accessor, is read once, as inspect reads it.
// These pin that exception and its limits; the behaviour does not change.
describe("scrubbedForInspect reads only an Error's own stack getter (S0g)", () => {
  const secret = 'stack-getter-sentinel-8d2f';

  function errorWithStackGetter(): {
    error: Error;
    stackGetter: () => string;
    stackCalls: () => number;
    detailCalls: () => number;
  } {
    let stack = 0;
    let detail = 0;
    const error = new Error('boom');
    const stackGetter = (): string => {
      stack += 1;
      return `Error: boom ${secret}\n    at fixture (fixture.ts:1:1)`;
    };
    Object.defineProperty(error, 'stack', {
      get: stackGetter,
      configurable: true,
    });
    Object.defineProperty(error, 'detail', {
      get: (): string => {
        detail += 1;
        return secret;
      },
      configurable: true,
      enumerable: true,
    });
    return {
      error,
      stackGetter,
      stackCalls: () => stack,
      detailCalls: () => detail,
    };
  }

  it('calls a user-defined own stack getter on an Error exactly once', () => {
    const { error, stackGetter, stackCalls } = errorWithStackGetter();

    scrubbedForInspect(error, [secret]);

    expect(stackCalls()).toBe(1);
    expect(stackGetter()).toContain(secret);
  });

  it('copies that stack as a scrubbed data property and leaves the original accessor', () => {
    const { error, stackGetter } = errorWithStackGetter();

    const copy = scrubbedForInspect(error, [secret]) as Error;
    const copied = Object.getOwnPropertyDescriptor(copy, 'stack');
    const original = Object.getOwnPropertyDescriptor(error, 'stack');

    expect(copied).toBeDefined();
    expect(copied).not.toHaveProperty('get');
    expect(copied).toHaveProperty('value');
    expect(copied?.value).toContain(REDACTED);
    expect(copied?.value).not.toContain(secret);
    expect(original).toHaveProperty('get', stackGetter);
    expect(original).not.toHaveProperty('value');
  });

  it('does not call another own getter on the same Error', () => {
    const { error, detailCalls } = errorWithStackGetter();

    const copy = scrubbedForInspect(error, [secret]) as Error;

    expect(detailCalls()).toBe(0);
    // The same descriptor, so the same getter function, uncalled.
    expect(Object.getOwnPropertyDescriptor(copy, 'detail')).toStrictEqual(
      Object.getOwnPropertyDescriptor(error, 'detail'),
    );
  });

  it('does not call an own stack getter on an object that is not an Error', () => {
    let calls = 0;
    const value = {
      get stack(): string {
        calls += 1;
        return secret;
      },
    };

    const copy = scrubbedForInspect(value, [secret]);

    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(copy, 'stack')).toHaveProperty(
      'get',
    );
  });

  it('the doc comment names the stack exception next to the getter rule', () => {
    const source = readAppFile('src/config/boot-output.ts');
    const at = source.indexOf('export function scrubbedForInspect(');
    const before = source.slice(0, at);
    const open = before.lastIndexOf('/**');
    const close = before.lastIndexOf('*/');
    const block = before.slice(open, close + 2);
    const text = block
      .split('\n')
      .map((line) => line.replace(/^\s*\/?\*+\/?\s?/, ''))
      .join(' ');
    const sentences = text.split(/(?<=\.)\s+/);

    expect(at).toBeGreaterThan(0);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(before.slice(close + 2)).toMatch(/^\s*$/);
    expect(block).not.toContain('Getters are copied, never called.');
    expect(text).not.toContain('Getters are copied, never called.');
    expect(
      sentences.some(
        (sentence) => /getter/i.test(sentence) && /`stack`/.test(sentence),
      ),
    ).toBe(true);
  });
});
