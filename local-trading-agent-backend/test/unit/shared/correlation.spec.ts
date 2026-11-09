import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import { pinoOptions } from '../../../src/config/logging.js';
import {
  currentCorrelationId,
  runWithCorrelation,
} from '../../../src/shared/correlation.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface LogLine {
  msg: string;
  correlationId?: string;
}

function captureLogger() {
  const lines: LogLine[] = [];
  const stream = {
    write(line: string) {
      lines.push(JSON.parse(line) as LogLine);
    },
  };

  return { logger: pino(pinoOptions, stream), lines };
}

describe('correlation scope', () => {
  it('stamps every line in the scope, including after an await', async () => {
    const { logger, lines } = captureLogger();

    await runWithCorrelation(async () => {
      logger.info('before');
      await delay(1);
      logger.info('after');
    }, 'scope-a');

    expect(lines).toMatchObject([
      { msg: 'before', correlationId: 'scope-a' },
      { msg: 'after', correlationId: 'scope-a' },
    ]);
  });

  it('keeps concurrent scopes apart', async () => {
    const { logger, lines } = captureLogger();
    const work = (id: string, waitMs: number) =>
      runWithCorrelation(async () => {
        logger.info(`${id}-before`);
        await delay(waitMs);
        logger.info(`${id}-after`);
      }, id);

    await Promise.all([work('a', 20), work('b', 5), work('c', 10)]);

    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line.msg.startsWith(`${line.correlationId ?? 'none'}-`)).toBe(
        true,
      );
    }
  });

  it('generates a UUID when no ID is given', () => {
    const first = runWithCorrelation(currentCorrelationId);
    const second = runWithCorrelation(currentCorrelationId);

    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it('returns the callback result', () => {
    expect(runWithCorrelation(() => 42)).toBe(42);
  });

  it('restores the outer scope after a nested one', () => {
    runWithCorrelation(() => {
      runWithCorrelation(() => {
        expect(currentCorrelationId()).toBe('inner');
      }, 'inner');

      expect(currentCorrelationId()).toBe('outer');
    }, 'outer');
  });

  it('leaves a line outside any scope without a correlationId', () => {
    const { logger, lines } = captureLogger();

    logger.info('outside');

    expect(currentCorrelationId()).toBeUndefined();
    expect(lines[0]).not.toHaveProperty('correlationId');
  });
});
