import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { BootConsoleLogger, printBootFailure } from './config/boot-output.js';
import { SETTINGS } from './config/config.module.js';
import type { Settings } from './config/settings.js';
import { IDENTITY } from './db/db.module.js';
import { identityLogFields, type DatabaseIdentity } from './db/identity.js';
import { runWithCorrelation } from './shared/correlation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Rethrow, so a failed boot reaches printBootFailure below (D11).
    abortOnError: false,
    bufferLogs: true,
    // Prints Nest's own lines, scrubbed, until useLogger hands them to pino.
    logger: new BootConsoleLogger(),
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  // UNKNOWN blocks entries (S7a) and never stops the boot: exits keep running.
  const identity = app.get<DatabaseIdentity>(IDENTITY);
  const line = { msg: 'Database identity', ...identityLogFields(identity) };
  if (identity.status === 'VERIFIED') logger.log(line, 'Database');
  else logger.warn(line, 'Database');

  const { TRADER_MODE } = app.get<Settings>(SETTINGS);
  logger.log({ msg: 'Trader started', mode: TRADER_MODE }, 'Bootstrap');

  await app.close();
}

await runWithCorrelation(bootstrap).catch(printBootFailure);
