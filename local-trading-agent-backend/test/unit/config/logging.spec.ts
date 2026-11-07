import { Test } from '@nestjs/testing';
import { Logger as NestPinoLogger, LoggerModule } from 'nestjs-pino';
import { pino, type Logger } from 'pino';
import { pinoOptions } from '../../../src/config/logging.js';
import { parseSettings } from '../../../src/config/settings.js';
import {
  FIXTURE_API_KEY,
  FIXTURE_DATABASE_URL,
  FIXTURE_DB_PASSWORD,
  fixtureEnv,
} from '../../fixtures/env.js';
import { nonSpecSources, readPackageJson } from '../../fixtures/repo.js';

function captureLogger(): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const stream = {
    write(line: string) {
      lines.push(line);
    },
  };

  return { logger: pino(pinoOptions, stream), output: () => lines.join('') };
}

function expectRedacted(output: string): void {
  expect(output).not.toContain(FIXTURE_API_KEY);
  expect(output).not.toContain(FIXTURE_DB_PASSWORD);
  expect(output).toContain('[REDACTED]');
}

describe('logging dependencies', () => {
  it.each(['pino', 'nestjs-pino'])('depends on %s', (name) => {
    expect(readPackageJson().dependencies).toHaveProperty(name);
  });
});

describe('log line shape', () => {
  it('writes level, msg and an ISO-8601 UTC time', () => {
    const { logger, output } = captureLogger();

    logger.info('hello');

    const line = JSON.parse(output()) as Record<string, unknown>;
    expect(line.level).toBe('info');
    expect(line.msg).toBe('hello');
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('secret redaction', () => {
  const settings = parseSettings(fixtureEnv);

  it('redacts { ANTHROPIC_API_KEY }', () => {
    const { logger, output } = captureLogger();

    logger.info({ ANTHROPIC_API_KEY: FIXTURE_API_KEY }, 'x');

    expectRedacted(output());
  });

  it('redacts { DATABASE_URL }', () => {
    const { logger, output } = captureLogger();

    logger.info({ DATABASE_URL: FIXTURE_DATABASE_URL }, 'x');

    expectRedacted(output());
  });

  it('redacts { settings }', () => {
    const { logger, output } = captureLogger();

    logger.info({ settings }, 'x');

    expectRedacted(output());
    expect(JSON.parse(output())).toMatchObject({
      settings: {
        ANTHROPIC_API_KEY: '[REDACTED]',
        DATABASE_URL: '[REDACTED]',
        TRADER_MODE: 'paper',
      },
    });
  });

  it('redacts the settings object itself', () => {
    const { logger, output } = captureLogger();

    logger.info(settings, 'x');

    expectRedacted(output());
    expect(JSON.parse(output())).toMatchObject({
      ANTHROPIC_API_KEY: '[REDACTED]',
      DATABASE_URL: '[REDACTED]',
      TRADER_MODE: 'paper',
    });
  });

  it('redacts settings under any other one-level key', () => {
    const { logger, output } = captureLogger();

    logger.info({ config: settings }, 'x');

    expectRedacted(output());
  });

  it('redacts child logger bindings', () => {
    const { logger, output } = captureLogger();

    logger.child({ settings }).info('x');

    expectRedacted(output());
  });

  it('redacts through the Nest logger too', async () => {
    const lines: string[] = [];
    const stream = {
      write(line: string) {
        lines.push(line);
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [pinoOptions, stream] })],
    }).compile();
    const logger = moduleRef.get(NestPinoLogger);

    logger.log({ settings });
    logger.log(settings);
    logger.log({ msg: 'x', ANTHROPIC_API_KEY: FIXTURE_API_KEY }, 'Context');
    await moduleRef.close();

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expectRedacted(line);
    }
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
