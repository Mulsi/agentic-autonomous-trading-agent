import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  Logger,
  PARAMS_PROVIDER_TOKEN,
  PinoLogger,
  type Params,
} from 'nestjs-pino';
import { symbols, type LoggerOptions } from 'pino';
import { AppModule } from '../../../src/app.module.js';
import { SETTINGS } from '../../../src/config/config.module.js';
import { parseSettings, type Settings } from '../../../src/config/settings.js';
import {
  FIXTURE_DATABASE_URL,
  FIXTURE_DB_PASSWORD,
  stubFixtureEnv,
} from '../../fixtures/env.js';
import { captureStream, expectClean, REDACTED } from '../../fixtures/logs.js';

// The real parseSettings, wrapped so the test can count boot-time parses.
vi.mock(import('../../../src/config/settings.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, parseSettings: vi.fn(actual.parseSettings) };
});

// The unit counterpart of the e2e wiring proof, so `pnpm test` (and the gate)
// catches an AppModule that builds its logger without the loaded secrets.
// nestjs-pino keeps one root logger per process: this file boots AppModule
// once, as main.ts does, and points that root logger at a capture stream.
describe('the AppModule logger', () => {
  const capture = captureStream();
  let app: INestApplicationContext;
  let lines: Record<string, unknown>[];

  beforeAll(async () => {
    stubFixtureEnv();
    app = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      bufferLogs: true,
    });
    const root = PinoLogger.root as unknown as Record<symbol, unknown>;
    root[symbols.streamSym] = capture.stream;
    const logger = app.get(Logger);
    app.useLogger(logger);

    const settings = app.get<Settings>(SETTINGS);
    logger.log({ msg: 'probe nested', a: { b: { c: settings } } }, 'Probe');
    logger.log({ msg: 'probe renamed', dsn: FIXTURE_DATABASE_URL }, 'Probe');
    logger.log(`probe interpolated ${FIXTURE_DATABASE_URL}`, 'Probe');
    logger.error(new Error(`probe error ${FIXTURE_DB_PASSWORD}`), 'Probe');

    lines = capture.lines.map(
      (raw) => JSON.parse(raw) as Record<string, unknown>,
    );
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('parses the settings once, at boot', () => {
    expect(vi.mocked(parseSettings)).toHaveBeenCalledTimes(1);
  });

  it('is built from the settings parsed at boot', () => {
    const params = app.get<Params>(PARAMS_PROVIDER_TOKEN);
    const options = params.pinoHttp as LoggerOptions;

    expect(options.hooks?.streamWrite?.(FIXTURE_DATABASE_URL)).toBe(REDACTED);
  });

  it('writes only clean lines, including the buffered boot lines', () => {
    expectClean(capture.lines, [FIXTURE_DB_PASSWORD, FIXTURE_DATABASE_URL]);
    expect(lines.map((line) => line.context)).toContain('InstanceLoader');
  });

  it('writes [REDACTED] where each secret was', () => {
    const probe = (msg: string) =>
      lines.find((line) => line.context === 'Probe' && line.msg === msg);

    expect(probe('probe nested')).toMatchObject({
      a: { b: { c: { DATABASE_URL: REDACTED, TRADER_MODE: 'paper' } } },
    });
    expect(probe('probe renamed')).toMatchObject({ dsn: REDACTED });
    expect(probe(`probe interpolated ${REDACTED}`)).toBeDefined();
    expect(probe(`probe error ${REDACTED}`)).toMatchObject({
      err: { message: `probe error ${REDACTED}` },
    });
  });
});
