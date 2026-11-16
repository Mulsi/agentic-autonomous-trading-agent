import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../../../src/market-data/normalizer.js';

// Hand-written synthetic fixtures in the documented Binance formats. Nothing
// here was fetched. The same eight 15m BTCUSDT bars from 2026-10-01T00:00Z
// appear twice: as bulk spot CSV lines with epoch-µs times (D12) and as a REST
// JSON array with epoch-ms times.

const here = import.meta.dirname;

/** 2026-10-01T00:00:00Z in epoch ms. */
export const ANCHOR_MS = 1790812800000;
export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
export const FIXTURE_BARS = 8;

function read(name: string): string {
  return readFileSync(join(here, name), 'utf8');
}

/** The bulk CSV, each line split into its 12 string fields. */
export function bulkCsvRows(): string[][] {
  return read('btcusdt-15m-2026-10-01.csv')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/** The REST JSON rows: numbers for times and the trade count, strings for money. */
export function restJsonRows(): unknown[][] {
  return JSON.parse(read('btcusdt-15m-2026-10-01.rest.json')) as unknown[][];
}

/**
 * The 5-minute metrics `create_time` column as epoch ms. The times are UTC
 * datetime strings, with a gap from 00:30 to 01:25.
 */
export function metricsOpenTimesMs(): number[] {
  return read('metrics-5m-create-times.txt')
    .split('\n')
    .slice(1)
    .filter((line) => line !== '')
    .map((line) => {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(line)) {
        throw new Error(`bad create_time ${line}`);
      }
      // An explicit Z: the strings are UTC, whatever the process time zone.
      return Date.parse(`${line.replace(' ', 'T')}Z`);
    });
}

/** A valid ms row from parts; any field can be overridden by index. */
export function msRow(
  openTimeMs: number,
  intervalMs: number,
  prices: {
    open: string;
    high: string;
    low: string;
    close: string;
  },
  overrides: Readonly<Record<number, unknown>> = {},
): unknown[] {
  const row: unknown[] = [
    openTimeMs,
    prices.open,
    prices.high,
    prices.low,
    prices.close,
    '10.00000000',
    openTimeMs + intervalMs - 1,
    '600000.00000000',
    100,
    '5.00000000',
    '300000.00000000',
    '0',
  ];
  for (const [index, value] of Object.entries(overrides)) {
    row[Number(index)] = value;
  }
  return row;
}

/** A candle's fields as plain strings, for deep comparison across Decimal instances. */
export function candleView(candle: Candle): Record<string, unknown> {
  return {
    symbol: candle.symbol,
    interval: candle.interval,
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
    tradeCount: candle.tradeCount,
  };
}
