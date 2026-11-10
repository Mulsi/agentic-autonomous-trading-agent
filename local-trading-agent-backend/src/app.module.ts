import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, SETTINGS } from './config/config.module.js';
import { loggerOptions } from './config/logging.js';
import { secretValues } from './config/secrets.js';
import type { Settings } from './config/settings.js';

@Module({
  imports: [
    ConfigModule,
    // Built from the settings parsed once at boot, so the logger scrubs the
    // loaded secret values. Nothing reads the environment a second time.
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [SETTINGS],
      useFactory: (settings: Settings) => ({
        pinoHttp: loggerOptions(secretValues(settings)),
      }),
    }),
  ],
})
export class AppModule {}
