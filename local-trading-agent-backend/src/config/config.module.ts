import { Module } from '@nestjs/common';
import { recordBootSecrets } from './boot-output.js';
import { secretValues } from './secrets.js';
import { parseSettings, type Settings } from './settings.js';

export const SETTINGS = Symbol('SETTINGS');

@Module({
  providers: [
    {
      provide: SETTINGS,
      // Parsed at boot, not at import, so importing a module needs no valid env.
      // The secret values are recorded here, from this one parse, for the
      // printers that run outside pino when the boot fails (boot-output.ts).
      useFactory: (): Settings => {
        const settings = parseSettings(process.env);
        recordBootSecrets(secretValues(settings));
        return settings;
      },
    },
  ],
  exports: [SETTINGS],
})
export class ConfigModule {}
