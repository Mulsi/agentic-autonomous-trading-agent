import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, SETTINGS } from './config/config.module.js';
import { loggerOptions } from './config/logging.js';
import { secretValues } from './config/secrets.js';
import type { Settings } from './config/settings.js';
import { DbModule } from './db/db.module.js';
import { MarketDataModule } from './market-data/market-data.module.js';

/**
 * The backfill command's context (S1b): AppModule's settings, logger and
 * database, plus the market-data providers. Only a write run boots it.
 */
@Module({
  imports: [
    ConfigModule,
    // Built exactly as AppModule builds it: from the settings parsed once at
    // boot, so the logger scrubs the loaded secret values.
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [SETTINGS],
      useFactory: (settings: Settings) => ({
        pinoHttp: loggerOptions(secretValues(settings)),
      }),
    }),
    DbModule,
    MarketDataModule,
  ],
})
export class BackfillModule {}
