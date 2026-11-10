import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Logger as NestPinoLogger, LoggerModule } from 'nestjs-pino';
import { pino, type Logger } from 'pino';
import { loggerOptions } from '../../../src/config/logging.js';
import { secretValues } from '../../../src/config/secrets.js';
import { parseSettings, type Settings } from '../../../src/config/settings.js';
import {
  FIXTURE_API_KEY,
  FIXTURE_DATABASE_URL,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
} from '../../fixtures/env.js';
import { captureStream, expectClean, REDACTED } from '../../fixtures/logs.js';
import { nonSpecSources, readPackageJson } from '../../fixtures/repo.js';

const S = FIXTURE_DB_PASSWORD;
const settings = parseSettings(fixtureEnv);

/** "The logger": pino on the options from logging.ts, for these settings. */
function captureLogger(forSettings: Settings = settings): {
  logger: Logger;
  lines: string[];
} {
  const { stream, lines } = captureStream();
  const options = loggerOptions(secretValues(forSettings));

  return { logger: pino(options, stream), lines };
}

/** Pino on the key paths alone: options built with no secret values. */
function keyPathLogger(): { logger: Logger; lines: string[] } {
  const { stream, lines } = captureStream();

  return { logger: pino(loggerOptions([]), stream), lines };
}

/** Clean for the fixture settings: no password and no URL as loaded. */
function expectCleanLines(lines: readonly string[]): Record<string, unknown>[] {
  return expectClean(lines, [S, FIXTURE_DATABASE_URL]);
}

function onlyLine(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const [line] = expectCleanLines(lines);
  return line ?? {};
}

describe('logging dependencies', () => {
  it.each(['pino', 'nestjs-pino'])('depends on %s', (name) => {
    expect(readPackageJson().dependencies).toHaveProperty(name);
  });
});

describe('log line shape', () => {
  it('writes level, msg and an ISO-8601 UTC time', () => {
    const { logger, lines } = captureLogger();

    logger.info('hello');

    const line = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(line.level).toBe('info');
    expect(line.msg).toBe('hello');
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('secret redaction by key path', () => {
  // Built with no secret values, so only the key paths can redact here.
  function expectRedacted(lines: readonly string[]): void {
    const output = lines.join('');
    expect(output).not.toContain(FIXTURE_API_KEY);
    expect(output).not.toContain(S);
    expect(output).toContain(REDACTED);
  }

  it('redacts { ANTHROPIC_API_KEY }, a defensive name with no setting', () => {
    const { logger, lines } = keyPathLogger();

    logger.info({ ANTHROPIC_API_KEY: FIXTURE_API_KEY }, 'x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      ANTHROPIC_API_KEY: REDACTED,
    });
  });

  it('redacts { DATABASE_URL }', () => {
    const { logger, lines } = keyPathLogger();

    logger.info({ DATABASE_URL: FIXTURE_DATABASE_URL }, 'x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      DATABASE_URL: REDACTED,
    });
  });

  it('redacts { settings }', () => {
    const { logger, lines } = keyPathLogger();

    logger.info({ settings }, 'x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      settings: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' },
    });
  });

  it('redacts the settings object itself', () => {
    const { logger, lines } = keyPathLogger();

    logger.info(settings, 'x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      DATABASE_URL: REDACTED,
      TRADER_MODE: 'paper',
    });
  });

  it('redacts settings under any other one-level key', () => {
    const { logger, lines } = keyPathLogger();

    logger.info({ config: settings }, 'x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      config: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' },
    });
  });

  it('redacts child logger bindings', () => {
    const { logger, lines } = keyPathLogger();

    logger.child({ settings }).info('x');

    expectRedacted(lines);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      settings: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' },
    });
  });

  it('keeps the key paths when secret values are given too', () => {
    const { logger, lines } = captureLogger();

    logger.info({ ANTHROPIC_API_KEY: FIXTURE_API_KEY, settings }, 'x');

    expectRedacted(lines);
    expect(onlyLine(lines)).toMatchObject({
      ANTHROPIC_API_KEY: REDACTED,
      settings: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' },
    });
  });
});

describe('value scrub: nested more than one level deep', () => {
  it('scrubs { a: { b: settings } }', () => {
    const { logger, lines } = captureLogger();

    logger.info({ a: { b: settings } }, 'x');

    expect(onlyLine(lines)).toMatchObject({
      a: { b: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' } },
    });
  });

  it('scrubs { a: { b: { c: settings } } }', () => {
    const { logger, lines } = captureLogger();

    logger.info({ a: { b: { c: settings } } }, 'x');

    expect(onlyLine(lines)).toMatchObject({
      a: { b: { c: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' } } },
    });
  });

  it('scrubs { list: [settings] }', () => {
    const { logger, lines } = captureLogger();

    logger.info({ list: [settings] }, 'x');

    expect(onlyLine(lines)).toMatchObject({
      list: [{ DATABASE_URL: REDACTED, TRADER_MODE: 'paper' }],
    });
  });
});

describe('value scrub: key names outside the key-path list', () => {
  it.each([
    ['apiKey', S],
    ['password', S],
    ['connectionString', FIXTURE_DATABASE_URL],
    ['dsn', FIXTURE_DATABASE_URL],
  ])('scrubs { %s }', (key, value) => {
    const { logger, lines } = captureLogger();

    logger.info({ [key]: value }, 'x');

    expect(onlyLine(lines)).toMatchObject({ [key]: REDACTED });
  });
});

describe('value scrub: interpolated into the message', () => {
  it('scrubs a template string holding the URL', () => {
    const { logger, lines } = captureLogger();

    logger.info(`connecting to ${FIXTURE_DATABASE_URL} now`);

    expect(onlyLine(lines).msg).toBe(`connecting to ${REDACTED} now`);
  });

  it('scrubs a template string holding the password', () => {
    const { logger, lines } = captureLogger();

    logger.info(`password ${S} rejected`);

    expect(onlyLine(lines).msg).toBe(`password ${REDACTED} rejected`);
  });

  it('scrubs printf-style interpolation', () => {
    const { logger, lines } = captureLogger();

    logger.info('connect %s', FIXTURE_DATABASE_URL);

    expect(onlyLine(lines).msg).toBe(`connect ${REDACTED}`);
  });
});

describe('value scrub: errors and bindings', () => {
  it('scrubs an error message and stack that hold the URL', () => {
    const { logger, lines } = captureLogger();
    const err = new Error(`cannot reach ${FIXTURE_DATABASE_URL}`);
    expect(err.stack).toContain(FIXTURE_DATABASE_URL);

    logger.error({ err });

    const line = onlyLine(lines) as { err: { message: string; stack: string } };
    expect(line.err.message).toBe(`cannot reach ${REDACTED}`);
    expect(line.err.stack).toContain(`cannot reach ${REDACTED}`);
  });

  it('scrubs an error whose cause holds the password', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('connect failed', {
      cause: new Error(`password ${S} rejected`),
    });

    logger.error({ err });

    expect(lines.join('')).toContain(`password ${REDACTED} rejected`);
    expectCleanLines(lines);
  });

  it('scrubs child bindings that hold the URL', () => {
    const { logger, lines } = captureLogger();

    logger.child({ conn: FIXTURE_DATABASE_URL }).info('x');

    expect(onlyLine(lines)).toMatchObject({ conn: REDACTED, msg: 'x' });
  });
});

describe('value scrub: encoded passwords', () => {
  const cases = [
    {
      name: 'escaped characters',
      url: `postgresql://trader:pw%22q%5Cs%40-${S}@localhost:5432/trader`,
      forms: [
        `postgresql://trader:pw%22q%5Cs%40-${S}@localhost:5432/trader`,
        `pw%22q%5Cs%40-${S}`,
        `pw"q\\s@-${S}`,
      ],
    },
    {
      name: 'mixed encoding',
      url: `postgresql://trader:mix@d%20${S}@localhost:5432/trader`,
      forms: [`postgresql://trader:mix@d%20${S}@localhost:5432/trader`],
    },
    {
      name: 'a password that does not decode',
      url: `postgresql://trader:pa%zz-${S}@localhost:5432/trader`,
      forms: [
        `postgresql://trader:pa%zz-${S}@localhost:5432/trader`,
        `pa%zz-${S}`,
      ],
    },
  ];

  it('the decoded form serializes with escaped characters', () => {
    expect(JSON.stringify(`pw"q\\s@-${S}`)).toBe(`"pw\\"q\\\\s@-${S}"`);
  });

  it.each(cases)('accepts the $name URL as a setting', ({ url }) => {
    expect(
      parseSettings({ ...fixtureEnv, DATABASE_URL: url }).DATABASE_URL,
    ).toBe(url);
  });

  it.each(cases)('builds the logger options for $name', ({ url }) => {
    const forSettings = parseSettings({ ...fixtureEnv, DATABASE_URL: url });

    expect(() => loggerOptions(secretValues(forSettings))).not.toThrow();
  });

  it.each(cases)('scrubs every form of $name', ({ url, forms }) => {
    const forSettings = parseSettings({ ...fixtureEnv, DATABASE_URL: url });
    const { logger, lines } = captureLogger(forSettings);

    for (const form of forms) {
      logger.info(`value ${form} end`);
      logger.info({ value: form }, 'x');
    }

    const parsed = expectClean(lines, [S, url]);
    expect(parsed).toHaveLength(forms.length * 2);
    for (const [index, line] of parsed.entries()) {
      if (index % 2 === 0) expect(line.msg).toBe(`value ${REDACTED} end`);
      else expect(line.value).toBe(REDACTED);
    }
  });
});

describe('value scrub: no secret, no change', () => {
  it.each([
    'postgresql://localhost/trader',
    'postgresql://trader@localhost/trader',
    'postgresql://trader:@localhost/trader',
  ])('leaves a line holding %s unchanged', (url) => {
    const forSettings = parseSettings({ ...fixtureEnv, DATABASE_URL: url });
    const { logger, lines } = captureLogger(forSettings);

    logger.info(`connecting to ${url}`);

    expect(secretValues(forSettings)).toEqual([]);
    expect(lines.join('')).not.toContain(REDACTED);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      msg: `connecting to ${url}`,
    });
  });

  it('leaves a line with no secret form unchanged when a password is set', () => {
    const { logger, lines } = captureLogger();

    logger.info({ host: 'localhost', port: 5432 }, 'connecting to trader');

    expect(lines.join('')).not.toContain(REDACTED);
    expect(JSON.parse(lines.join(''))).toMatchObject({
      msg: 'connecting to trader',
      host: 'localhost',
      port: 5432,
    });
  });
});

describe('through the nestjs-pino Logger', () => {
  // nestjs-pino keeps one root logger per process, so this file builds one
  // LoggerModule and shares it between tests.
  const capture = captureStream();
  let moduleRef: TestingModule;
  let logger: NestPinoLogger;

  beforeAll(async () => {
    const options = loggerOptions(secretValues(settings));
    moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [options, capture.stream] })],
    }).compile();
    logger = moduleRef.get(NestPinoLogger);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    capture.lines.length = 0;
  });

  it('redacts through the Nest logger too', () => {
    logger.log({ settings });
    logger.log(settings);
    logger.log({ msg: 'x', ANTHROPIC_API_KEY: FIXTURE_API_KEY }, 'Context');

    expect(capture.lines).toHaveLength(3);
    for (const line of expectCleanLines(capture.lines)) {
      expect(JSON.stringify(line)).not.toContain(FIXTURE_API_KEY);
      expect(JSON.stringify(line)).toContain(REDACTED);
    }
  });

  it('scrubs one shape from each value-scrub case', () => {
    logger.log({ msg: 'nested', a: { b: { c: settings } } });
    logger.log({ msg: 'renamed', dsn: FIXTURE_DATABASE_URL }, 'Context');
    logger.log(`connecting to ${FIXTURE_DATABASE_URL}`, 'Context');
    logger.error(new Error(`cannot reach ${FIXTURE_DATABASE_URL}`), 'Context');

    const [nested, renamed, message, error] = expectCleanLines(capture.lines);
    expect(capture.lines).toHaveLength(4);
    expect(nested).toMatchObject({
      a: { b: { c: { DATABASE_URL: REDACTED } } },
    });
    expect(renamed).toMatchObject({ dsn: REDACTED, context: 'Context' });
    expect(message).toMatchObject({
      msg: `connecting to ${REDACTED}`,
      context: 'Context',
    });
    expect(error).toMatchObject({
      err: { message: `cannot reach ${REDACTED}` },
      context: 'Context',
    });
  });
});

describe('source hygiene', () => {
  it('has no console call in non-spec source', () => {
    const offenders = nonSpecSources()
      .filter(({ text }) => text.includes('console.'))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
