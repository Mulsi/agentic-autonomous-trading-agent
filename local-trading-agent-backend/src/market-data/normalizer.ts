import { z } from 'zod';
import { Decimal, parseNonNegativeDecimal } from '../shared/decimal.js';

// Pure functions only (D13): live trading and the S6 replay call this same
// code. No Nest, database, network, clock, environment or logging.

/** The slice 1 timeframes (§2). */
export type KlineInterval = '15m' | '1h' | '4h' | '1d';

/** Interval lengths in epoch milliseconds. */
export const INTERVAL_MS: Readonly<Record<KlineInterval, number>> =
  Object.freeze({
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  });

export function isKlineInterval(value: unknown): value is KlineInterval {
  return typeof value === 'string' && Object.hasOwn(INTERVAL_MS, value);
}

/** Throws a TypeError naming `interval` for anything but a slice 1 timeframe. */
export function intervalMs(interval: KlineInterval): number {
  if (!isKlineInterval(interval)) {
    throw new TypeError(
      `interval must be one of ${Object.keys(INTERVAL_MS).join(', ')}`,
    );
  }
  return INTERVAL_MS[interval];
}

// D12: REST sends epoch milliseconds, bulk spot files epoch microseconds.
// 2017-01-01T00:00:00Z inclusive to 2100-01-01T00:00:00Z exclusive, per unit.
// The two ranges do not overlap, so no value is read as both units.
const MS_MIN = 1_483_228_800_000;
const MS_END = 4_102_444_800_000;
const US_MIN = MS_MIN * 1000;
const US_END = MS_END * 1000;

/** A positive integer of at most 16 digits, with no sign, space or leading 0. */
const EPOCH_STRING = /^[1-9][0-9]{0,15}$/;

export type EpochUnit = 'ms' | 'us';

export type EpochResult =
  | { readonly ok: true; ms: number; unit: EpochUnit; value: number }
  | { readonly ok: false };

/**
 * Reads one epoch timestamp in ms or µs and converts it to epoch ms. `value`
 * is the integer in its source unit. A value that fits neither unit fails.
 */
export function normalizeEpoch(raw: unknown): EpochResult {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && EPOCH_STRING.test(raw)) {
    value = Number(raw);
  } else {
    return { ok: false };
  }
  if (!Number.isSafeInteger(value)) return { ok: false };

  if (value >= MS_MIN && value < MS_END) {
    return { ok: true, ms: value, unit: 'ms', value };
  }
  if (value >= US_MIN && value < US_END) {
    // Exact integer arithmetic: the floor of value / 1000.
    return { ok: true, ms: (value - (value % 1000)) / 1000, unit: 'us', value };
  }
  return { ok: false };
}

/** One validated kline. Money is Decimal; times are UTC epoch ms. */
export interface Candle {
  readonly symbol: string;
  readonly interval: KlineInterval;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly quoteVolume: Decimal;
  readonly takerBuyBaseVolume: Decimal;
  readonly takerBuyQuoteVolume: Decimal;
  /** A count, not money. */
  readonly tradeCount: number;
}

/** Row-level failure reasons, in the order the checks run. */
export const ROW_REJECT_REASONS = [
  'malformed_row',
  'bad_timestamp',
  'timestamp_unit_mismatch',
  'misaligned_open_time',
  'bad_close_time',
  'bad_number',
  'non_positive_price',
  'ohlc_inconsistent',
  'volume_inconsistent',
] as const;

export type RowRejectReason = (typeof ROW_REJECT_REASONS)[number];

export type RowResult =
  | { readonly ok: true; candle: Candle }
  | { readonly ok: false; reason: RowRejectReason; openTimeMs?: number };

/**
 * The Binance kline array: openTime, open, high, low, close, volume,
 * closeTime, quoteVolume, tradeCount, takerBuyBaseVolume,
 * takerBuyQuoteVolume, ignore. REST JSON and a bulk CSV line split into its
 * fields both have this shape. The twelfth element is never read.
 */
const klineRowSchema = z.array(z.unknown()).length(12);

const DIGITS = /^[0-9]+$/;

/** A non-negative safe integer, given as a number or a string of digits. */
function parseCount(value: unknown): number | undefined {
  let count: number;
  if (typeof value === 'number') {
    count = value;
  } else if (typeof value === 'string' && DIGITS.test(value)) {
    count = Number(value);
  } else {
    return undefined;
  }
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  // -0 becomes 0, so equal counts are equal values.
  return count === 0 ? 0 : count;
}

function reject(reason: RowRejectReason, openTimeMs?: number): RowResult {
  return openTimeMs === undefined
    ? { ok: false, reason }
    : { ok: false, reason, openTimeMs };
}

/**
 * Turns one raw kline row into a `Candle`, or names the first check it fails.
 * The row is data: it is only checked against a schema and parsed. A bad row
 * never throws; an unknown `interval` does, because it is a programmer error.
 */
export function normalizeKlineRow(
  row: unknown,
  symbol: string,
  interval: KlineInterval,
): RowResult {
  const stepMs = intervalMs(interval);

  const shape = klineRowSchema.safeParse(row);
  if (!shape.success) return reject('malformed_row');
  const fields = shape.data;

  const openTime = normalizeEpoch(fields[0]);
  const closeTime = normalizeEpoch(fields[6]);
  const openTimeMs = openTime.ok ? openTime.ms : undefined;
  if (!openTime.ok || !closeTime.ok) return reject('bad_timestamp', openTimeMs);

  if (openTime.unit !== closeTime.unit) {
    return reject('timestamp_unit_mismatch', openTime.ms);
  }
  const step = openTime.unit === 'us' ? stepMs * 1000 : stepMs;
  if (openTime.value % step !== 0) {
    return reject('misaligned_open_time', openTime.ms);
  }
  if (closeTime.value !== openTime.value + step - 1) {
    return reject('bad_close_time', openTime.ms);
  }

  const open = parseNonNegativeDecimal(fields[1]);
  const high = parseNonNegativeDecimal(fields[2]);
  const low = parseNonNegativeDecimal(fields[3]);
  const close = parseNonNegativeDecimal(fields[4]);
  const volume = parseNonNegativeDecimal(fields[5]);
  const quoteVolume = parseNonNegativeDecimal(fields[7]);
  const tradeCount = parseCount(fields[8]);
  const takerBuyBaseVolume = parseNonNegativeDecimal(fields[9]);
  const takerBuyQuoteVolume = parseNonNegativeDecimal(fields[10]);
  if (
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    volume === undefined ||
    quoteVolume === undefined ||
    tradeCount === undefined ||
    takerBuyBaseVolume === undefined ||
    takerBuyQuoteVolume === undefined
  ) {
    return reject('bad_number', openTime.ms);
  }

  if (open.isZero() || high.isZero() || low.isZero() || close.isZero()) {
    return reject('non_positive_price', openTime.ms);
  }

  if (
    high.lt(Decimal.max(open, close)) ||
    low.gt(Decimal.min(open, close)) ||
    low.gt(high)
  ) {
    return reject('ohlc_inconsistent', openTime.ms);
  }

  if (takerBuyBaseVolume.gt(volume) || takerBuyQuoteVolume.gt(quoteVolume)) {
    return reject('volume_inconsistent', openTime.ms);
  }

  return {
    ok: true,
    candle: {
      symbol,
      interval,
      openTimeMs: openTime.ms,
      closeTimeMs: closeTime.ms,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
      tradeCount,
    },
  };
}
