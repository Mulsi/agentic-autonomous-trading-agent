import { Module } from '@nestjs/common';
import type { Database } from '../db/client.js';
import { DATABASE, DbModule } from '../db/db.module.js';
import { loadKlines } from './bulk-loader.js';
import { DrizzleCandleSink } from './candle-store.js';
import { visionHttpGet } from './vision-http.js';

/** The loader's `HttpGet`: the bounded GET, for spot bulk-data URLs only. */
export const HTTP_GET = Symbol('HTTP_GET');
/** The Drizzle `CandleSink`. */
export const CANDLE_SINK = Symbol('CANDLE_SINK');
/** `loadKlines`, the pure pipeline. */
export const BULK_LOADER = Symbol('BULK_LOADER');

@Module({
  imports: [DbModule],
  providers: [
    { provide: HTTP_GET, useFactory: () => visionHttpGet() },
    {
      provide: CANDLE_SINK,
      inject: [DATABASE],
      useFactory: (db: Database) => new DrizzleCandleSink(db),
    },
    { provide: BULK_LOADER, useValue: loadKlines },
  ],
  exports: [HTTP_GET, CANDLE_SINK, BULK_LOADER],
})
export class MarketDataModule {}
