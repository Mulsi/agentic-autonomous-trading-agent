import { Module } from '@nestjs/common';
import { parseSettings, type Settings } from './settings.js';

export const SETTINGS = Symbol('SETTINGS');

@Module({
  providers: [
    {
      provide: SETTINGS,
      // Parsed at boot, not at import, so importing a module needs no valid env.
      useFactory: (): Settings => parseSettings(process.env),
    },
  ],
  exports: [SETTINGS],
})
export class ConfigModule {}
