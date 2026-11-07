import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { SETTINGS } from './config/config.module.js';
import type { Settings } from './config/settings.js';
import { runWithCorrelation } from './shared/correlation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    // Rethrow, so a failed boot reaches the top-level await below (D11).
    abortOnError: false,
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const { TRADER_MODE } = app.get<Settings>(SETTINGS);
  logger.log({ msg: 'Trader started', mode: TRADER_MODE }, 'Bootstrap');

  await app.close();
}

await runWithCorrelation(bootstrap);
