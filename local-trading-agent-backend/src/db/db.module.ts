import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, SETTINGS } from '../config/config.module.js';
import type { Settings } from '../config/settings.js';
import { connectDatabase, type DatabaseConnection } from './client.js';
import { decideIdentity, type DatabaseIdentity } from './identity.js';

/** The open connection. Tests that boot AppModule without Postgres replace it. */
export const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');
/** The Drizzle instance (`Database` from client.ts). */
export const DATABASE = Symbol('DATABASE');
/** The boot's identity result (`DatabaseIdentity` from identity.ts). */
export const IDENTITY = Symbol('IDENTITY');

@Module({
  imports: [ConfigModule],
  providers: [
    {
      // Connects while the context is created, after the settings parsed. A
      // failed connect fails the boot (D11). The marker read never does.
      provide: DATABASE_CONNECTION,
      inject: [SETTINGS],
      useFactory: (settings: Settings | null): Promise<DatabaseConnection> =>
        // When the settings provider throws, Nest can still call this factory,
        // with null. That boot is already refused: never connect for it.
        settings === null || typeof settings !== 'object'
          ? Promise.reject(
              new Error('No valid settings: no database connection'),
            )
          : connectDatabase(settings),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection) => connection.db,
    },
    {
      provide: IDENTITY,
      inject: [SETTINGS, DATABASE_CONNECTION],
      useFactory: (
        settings: Settings,
        connection: DatabaseConnection,
      ): DatabaseIdentity =>
        decideIdentity(settings.DATABASE_IDENTITY, connection.marker),
    },
  ],
  exports: [DATABASE, IDENTITY],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly connection: DatabaseConnection,
  ) {}

  /** Closing the context ends the pool, so main.ts exits by itself. */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
