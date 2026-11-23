import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { assets, candles, marketDataQuarantine } from '../db/schema.js';
import { Decimal } from '../shared/decimal.js';
import type { BulkFile } from './binance-vision.js';
import type { CsvLine } from './bulk-csv.js';
import {
  BULK_SOURCE,
  quarantineRow,
  storedRows,
  type CandleSink,
  type StoredCandle,
  type StoredQuarantine,
  type WriteResult,
} from './bulk-loader.js';
import type { Candle } from './normalizer.js';
import type { KlineBatch } from './validator.js';

// The one place under src/ that writes market data (S1b). Writes go only
// through the Drizzle query builder with bound parameters: no raw SQL, and a
// stored row is never changed or removed. Each file is one transaction.

/** The Drizzle transaction handle. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Rows per insert statement. Postgres binds at most 65,535 parameters per
 * statement; a candle row binds 17 and a quarantine row 9, so 1,000 rows stay
 * well under it.
 */
export const INSERT_CHUNK_ROWS = 1000;

const EXCHANGE = 'binance';
const MARKET_TYPE = 'spot';
const QUOTE_ASSET = 'USDT';

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += INSERT_CHUNK_ROWS) {
    out.push(items.slice(at, at + INSERT_CHUNK_ROWS));
  }
  return out;
}

type StoredCandleRow = typeof candles.$inferSelect;

/** The ten market fields: the times by `===`, the rest by `Decimal.eq`. */
export function sameMarketFields(
  row: StoredCandleRow,
  candle: Candle,
): boolean {
  return (
    row.openTimeMs === candle.openTimeMs &&
    row.closeTimeMs === candle.closeTimeMs &&
    new Decimal(row.open).eq(candle.open) &&
    new Decimal(row.high).eq(candle.high) &&
    new Decimal(row.low).eq(candle.low) &&
    new Decimal(row.close).eq(candle.close) &&
    new Decimal(row.volume).eq(candle.volume) &&
    new Decimal(row.quoteVolume).eq(candle.quoteVolume) &&
    new Decimal(row.takerBuyBaseVolume).eq(candle.takerBuyBaseVolume) &&
    new Decimal(row.takerBuyQuoteVolume).eq(candle.takerBuyQuoteVolume) &&
    new Decimal(row.tradeCount.toString()).eq(candle.tradeCount)
  );
}

export class DrizzleCandleSink implements CandleSink {
  constructor(private readonly db: Database) {}

  storeFile(
    file: BulkFile,
    batch: KlineBatch,
    lines: readonly CsvLine[],
  ): Promise<WriteResult> {
    const rows = storedRows(file, batch, lines);
    return this.db.transaction(async (tx) => {
      const assetId = await this.assetId(tx, file.symbol);
      const insertedTimes = await this.insertCandles(
        tx,
        assetId,
        file,
        rows.candles,
      );
      const notInserted = rows.candles.filter(
        ({ candle }) => !insertedTimes.has(candle.openTimeMs),
      );
      const conflicts = await this.conflicts(tx, assetId, file, notInserted);
      await this.insertQuarantine(tx, [...rows.quarantine, ...conflicts]);
      return {
        inserted: insertedTimes.size,
        alreadyStored: notInserted.length - conflicts.length,
        storedConflicts: conflicts.length,
      };
    });
  }

  /** Inserts the asset if it is absent, then reads its id. */
  protected async assetId(tx: Transaction, symbol: string): Promise<string> {
    await tx
      .insert(assets)
      .values({
        exchange: EXCHANGE,
        marketType: MARKET_TYPE,
        symbol,
        baseAsset: symbol.slice(0, -QUOTE_ASSET.length),
        quoteAsset: QUOTE_ASSET,
      })
      .onConflictDoNothing();
    const found = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.exchange, EXCHANGE),
          eq(assets.marketType, MARKET_TYPE),
          eq(assets.symbol, symbol),
        ),
      );
    const [asset] = found;
    if (found.length !== 1 || asset === undefined) {
      throw new Error('Expected exactly one asset row');
    }
    return asset.id;
  }

  /** The open times of the candles this call inserted. */
  protected async insertCandles(
    tx: Transaction,
    assetId: string,
    file: BulkFile,
    stored: readonly StoredCandle[],
  ): Promise<Set<number>> {
    const inserted = new Set<number>();
    for (const chunk of chunks(stored)) {
      const returned = await tx
        .insert(candles)
        .values(
          chunk.map(({ candle, outlierChecked }) => ({
            assetId,
            timeframe: file.interval,
            openTimeMs: candle.openTimeMs,
            closeTimeMs: candle.closeTimeMs,
            open: candle.open.toFixed(),
            high: candle.high.toFixed(),
            low: candle.low.toFixed(),
            close: candle.close.toFixed(),
            volume: candle.volume.toFixed(),
            quoteVolume: candle.quoteVolume.toFixed(),
            takerBuyBaseVolume: candle.takerBuyBaseVolume.toFixed(),
            takerBuyQuoteVolume: candle.takerBuyQuoteVolume.toFixed(),
            tradeCount: BigInt(candle.tradeCount),
            isClosed: true,
            outlierChecked,
            source: BULK_SOURCE,
          })),
        )
        .onConflictDoNothing()
        .returning({ openTimeMs: candles.openTimeMs });
      for (const row of returned) inserted.add(row.openTimeMs);
    }
    return inserted;
  }

  /**
   * Compares each candle that was already stored with the stored row. A
   * difference quarantines the incoming line as `stored_conflict`; the stored
   * row is never changed, `outlier_checked` included.
   */
  protected async conflicts(
    tx: Transaction,
    assetId: string,
    file: BulkFile,
    notInserted: readonly StoredCandle[],
  ): Promise<StoredQuarantine[]> {
    const found: StoredQuarantine[] = [];
    for (const chunk of chunks(notInserted)) {
      const storedRowsFound = await tx
        .select()
        .from(candles)
        .where(
          and(
            eq(candles.assetId, assetId),
            eq(candles.timeframe, file.interval),
            inArray(
              candles.openTimeMs,
              chunk.map(({ candle }) => candle.openTimeMs),
            ),
          ),
        );
      const byTime = new Map(
        storedRowsFound.map((row) => [row.openTimeMs, row]),
      );
      for (const { candle, line } of chunk) {
        const row = byTime.get(candle.openTimeMs);
        if (row === undefined) {
          // Not inserted and not stored: the database changed under us.
          throw new Error('A candle was neither inserted nor stored');
        }
        if (!sameMarketFields(row, candle)) {
          found.push(
            quarantineRow(file, line, 'stored_conflict', candle.openTimeMs),
          );
        }
      }
    }
    return found;
  }

  /** Appends the quarantine rows; a row already recorded stays as it is. */
  protected async insertQuarantine(
    tx: Transaction,
    rows: readonly StoredQuarantine[],
  ): Promise<void> {
    for (const chunk of chunks(rows)) {
      await tx
        .insert(marketDataQuarantine)
        .values(
          chunk.map((row) => ({
            source: row.source,
            sourceFile: row.sourceFile,
            rowIndex: row.rowIndex,
            symbol: row.symbol,
            timeframe: row.timeframe,
            reason: row.reason,
            openTimeMs: row.openTimeMs,
            raw: row.raw,
          })),
        )
        .onConflictDoNothing();
    }
  }
}
