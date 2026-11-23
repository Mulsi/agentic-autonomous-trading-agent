import { Decimal } from '../shared/decimal.js';
import {
  type Candle,
  type KlineInterval,
  type RowRejectReason,
  intervalMs,
  normalizeKlineRow,
} from './normalizer.js';

// Pure functions only (D13): live trading and the S6 replay call this same
// code. The caller passes the clock as `asOfMs`. Argument errors throw; row
// content never does.

export type QuarantineReason =
  | RowRejectReason
  | 'future_bar'
  | 'outside_range'
  | 'duplicate_conflict'
  | 'outlier';

/** A row kept out of `candles`, with everything needed to log or store it. */
export interface QuarantineRecord {
  readonly reason: QuarantineReason;
  /** The input row exactly as given. It is data, never instructions. */
  readonly raw: unknown;
  /** Set whenever the open time was readable. */
  readonly openTimeMs?: number;
  /** Set whenever the row parsed into a candle. */
  readonly candle?: Candle;
}

/** A half-open range of open times, `[fromMs, toMs)`. */
export interface MissingRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface OutlierOptions {
  /** How many earlier true-range ratios the median covers. No default. */
  readonly window: number;
  /** A bar is an outlier above this multiple of that median. No default. */
  readonly maxRangeMultiple: number;
}

export interface ValidateKlinesOptions {
  readonly symbol: string;
  readonly interval: KlineInterval;
  /** Half-open over open times. Both ends aligned to the interval. */
  readonly range: { readonly fromMs: number; readonly toMs: number };
  /** The caller's clock; in replay, the replay time. */
  readonly asOfMs: number;
  readonly outlier: OutlierOptions;
  /** Earlier checked candles, ascending, ending before `range.fromMs`. */
  readonly history?: readonly Candle[];
}

export interface KlineBatch {
  /** Accepted closed candles, strictly ascending by `openTimeMs`. */
  readonly candles: readonly Candle[];
  /** Closed candles past every hard check and the duplicate rule: `candles` plus the outliers. */
  readonly checked: readonly Candle[];
  /** Valid bars not yet closed at `asOfMs`, ascending. */
  readonly open: readonly Candle[];
  /** Every rejected row, in input order. */
  readonly quarantined: readonly QuarantineRecord[];
  /** Expected slots with no accepted candle, as maximal ranges. */
  readonly missing: readonly MissingRange[];
  /**
   * Open times of accepted candles the outlier rule could not judge: too few
   * earlier bars, or a zero reference median (after a run of zero-range bars).
   */
  readonly unjudged: readonly number[];
  readonly duplicatesCollapsed: number;
  readonly outOfOrder: number;
}

function requireSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return value;
}

function checkOptions(options: ValidateKlinesOptions): number {
  const stepMs = intervalMs(options.interval);

  const fromMs = requireSafeInteger(options.range.fromMs, 'range.fromMs');
  const toMs = requireSafeInteger(options.range.toMs, 'range.toMs');
  if (fromMs % stepMs !== 0) {
    throw new RangeError('range.fromMs must be aligned to the interval');
  }
  if (toMs % stepMs !== 0) {
    throw new RangeError('range.toMs must be aligned to the interval');
  }
  if (fromMs > toMs) {
    throw new RangeError('range.fromMs must not be after range.toMs');
  }

  requireSafeInteger(options.asOfMs, 'asOfMs');

  const { window, maxRangeMultiple } = options.outlier;
  if (!Number.isInteger(window) || window < 1) {
    throw new RangeError('outlier.window must be an integer >= 1');
  }
  if (!Number.isFinite(maxRangeMultiple) || maxRangeMultiple <= 0) {
    throw new RangeError('outlier.maxRangeMultiple must be finite and > 0');
  }

  const history = options.history ?? [];
  history.forEach((candle, index) => {
    if (
      candle.symbol !== options.symbol ||
      candle.interval !== options.interval
    ) {
      throw new RangeError(
        `history[${index}] must have symbol ${options.symbol} and interval ${options.interval}`,
      );
    }
    const previous = history[index - 1];
    if (previous !== undefined && candle.openTimeMs <= previous.openTimeMs) {
      throw new RangeError('history must be strictly ascending by openTimeMs');
    }
  });
  const last = history.at(-1);
  if (last !== undefined && !(last.closeTimeMs < fromMs)) {
    throw new RangeError('history must end before range.fromMs');
  }

  return stepMs;
}

/** True when every field of two candles for the same slot is equal. */
function sameValues(a: Candle, b: Candle): boolean {
  return (
    a.openTimeMs === b.openTimeMs &&
    a.closeTimeMs === b.closeTimeMs &&
    a.tradeCount === b.tradeCount &&
    a.open.eq(b.open) &&
    a.high.eq(b.high) &&
    a.low.eq(b.low) &&
    a.close.eq(b.close) &&
    a.volume.eq(b.volume) &&
    a.quoteVolume.eq(b.quoteVolume) &&
    a.takerBuyBaseVolume.eq(b.takerBuyBaseVolume) &&
    a.takerBuyQuoteVolume.eq(b.takerBuyQuoteVolume)
  );
}

/**
 * The true-range ratio of `bar` against its predecessor's close:
 * `(max(high, prevClose) - min(low, prevClose)) / prevClose`.
 */
function trueRangeRatio(bar: Candle, previous: Candle): Decimal {
  const prevClose = previous.close;
  return Decimal.max(bar.high, prevClose)
    .minus(Decimal.min(bar.low, prevClose))
    .div(prevClose);
}

/** The median; for an even count, the mean of the two middle values. */
function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as Decimal;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] as Decimal;
  return lower.plus(upper).div(2);
}

/**
 * Why a bar was or was not judged. Both unjudged cases are accepted and listed
 * in `unjudged`; the result does not carry the reason.
 * - `warm_up`: fewer than `window + 1` bars before it.
 * - `zero_median`: the median of the previous `window` ratios is zero, for
 *   example after a halt or a run of zero-trade bars where o = h = l = c =
 *   the previous close. There is no scale to judge against, and any floor
 *   would be an invented threshold, so the bar is not flagged.
 */
type Verdict =
  'accepted' | 'outlier' | 'unjudged_warm_up' | 'unjudged_zero_median';

/**
 * Causal outlier verdicts for the batch bars, which follow `history` in
 * `series`. Bar `k` is judged only from bars `0..k`. Flagged bars stay in the
 * series as reference points. What that guarantees:
 * - A single shock (a spike or a level shift) moves the median by at most one
 *   ratio, so the bars after it are judged against their normal scale.
 * - After a lasting rise in bar range, at most `floor(window / 2) + 1` bars of
 *   the new range are flagged (with `maxRangeMultiple >= 1`); by then the
 *   median holds the new range.
 * - After a run of zero-range bars, no bar is flagged because the median is
 *   zero: such bars stay unjudged until the median is non-zero again. This
 *   does not mean nothing after a flat run is flagged. Zero ratios left in
 *   the window bias the median low for up to `window` bars after the run, so
 *   a bar in that span can be flagged against a lower threshold; that fails
 *   safe (the slot goes missing).
 */
function outlierVerdicts(
  series: readonly Candle[],
  firstBatchIndex: number,
  { window, maxRangeMultiple }: OutlierOptions,
): Verdict[] {
  const ratios: Decimal[] = series.map((bar, k) => {
    const previous = series[k - 1];
    return previous === undefined
      ? new Decimal(0)
      : trueRangeRatio(bar, previous);
  });
  const multiple = new Decimal(maxRangeMultiple);
  const verdicts: Verdict[] = [];
  for (let k = firstBatchIndex; k < series.length; k += 1) {
    if (k < window + 1) {
      verdicts.push('unjudged_warm_up');
      continue;
    }
    const reference = median(ratios.slice(k - window, k));
    if (reference.isZero()) {
      verdicts.push('unjudged_zero_median');
      continue;
    }
    const ratio = ratios[k] as Decimal;
    verdicts.push(ratio.gt(multiple.times(reference)) ? 'outlier' : 'accepted');
  }
  return verdicts;
}

interface Parsed {
  readonly index: number;
  readonly raw: unknown;
  readonly candle: Candle;
}

/**
 * Validates one batch of raw kline rows. Every input row ends in exactly one
 * of `candles`, `open`, `quarantined`, or the `duplicatesCollapsed` count.
 */
export function validateKlines(
  rows: readonly unknown[],
  options: ValidateKlinesOptions,
): KlineBatch {
  const stepMs = checkOptions(options);
  const { symbol, interval, range, asOfMs } = options;
  const history = options.history ?? [];

  const quarantined: { index: number; record: QuarantineRecord }[] = [];
  const quarantine = (
    index: number,
    raw: unknown,
    reason: QuarantineReason,
    openTimeMs: number | undefined,
    candle?: Candle,
  ): void => {
    quarantined.push({
      index,
      record: {
        reason,
        raw,
        ...(openTimeMs === undefined ? {} : { openTimeMs }),
        ...(candle === undefined ? {} : { candle }),
      },
    });
  };

  // 1, 2 and the order count.
  let outOfOrder = 0;
  let previousOpenTimeMs: number | undefined;
  const slots = new Map<number, Parsed[]>();
  rows.forEach((raw, index) => {
    const result = normalizeKlineRow(raw, symbol, interval);
    const openTimeMs = result.ok ? result.candle.openTimeMs : result.openTimeMs;
    if (openTimeMs !== undefined) {
      if (previousOpenTimeMs !== undefined && openTimeMs < previousOpenTimeMs) {
        outOfOrder += 1;
      }
      previousOpenTimeMs = openTimeMs;
    }

    if (!result.ok) {
      quarantine(index, raw, result.reason, result.openTimeMs);
      return;
    }
    const { candle } = result;
    if (candle.openTimeMs > asOfMs) {
      quarantine(index, raw, 'future_bar', candle.openTimeMs, candle);
      return;
    }
    if (candle.openTimeMs < range.fromMs || candle.openTimeMs >= range.toMs) {
      quarantine(index, raw, 'outside_range', candle.openTimeMs, candle);
      return;
    }
    const copies = slots.get(candle.openTimeMs) ?? [];
    copies.push({ index, raw, candle });
    slots.set(candle.openTimeMs, copies);
  });

  // 3. Duplicates.
  let duplicatesCollapsed = 0;
  const unique: Candle[] = [];
  for (const copies of slots.values()) {
    const [first] = copies as [Parsed, ...Parsed[]];
    if (copies.every(({ candle }) => sameValues(candle, first.candle))) {
      unique.push(first.candle);
      duplicatesCollapsed += copies.length - 1;
    } else {
      for (const { index, raw, candle } of copies) {
        quarantine(index, raw, 'duplicate_conflict', candle.openTimeMs, candle);
      }
    }
  }

  // 4 and 5. Sorted output; closed against open.
  unique.sort((a, b) => a.openTimeMs - b.openTimeMs);
  const closed = unique.filter((candle) => candle.closeTimeMs < asOfMs);
  const open = unique.filter((candle) => candle.closeTimeMs >= asOfMs);

  // 6. Outliers, over history followed by the closed batch bars.
  const verdicts = outlierVerdicts(
    [...history, ...closed],
    history.length,
    options.outlier,
  );
  const candles: Candle[] = [];
  const unjudged: number[] = [];
  closed.forEach((candle, k) => {
    const verdict = verdicts[k];
    if (verdict === 'outlier') {
      const copy = slots.get(candle.openTimeMs)?.[0] as Parsed;
      quarantine(copy.index, copy.raw, 'outlier', candle.openTimeMs, candle);
      return;
    }
    candles.push(candle);
    if (verdict === 'unjudged_warm_up' || verdict === 'unjudged_zero_median') {
      unjudged.push(candle.openTimeMs);
    }
  });

  // 7. Missing: expected slots are those closed by asOfMs.
  const expectedSlots = Math.max(
    0,
    Math.min(
      (range.toMs - range.fromMs) / stepMs,
      Math.floor((asOfMs - stepMs - range.fromMs) / stepMs) + 1,
    ),
  );
  const missing = missingRanges(
    candles.map((candle) => candle.openTimeMs),
    {
      fromMs: range.fromMs,
      toMs: range.fromMs + expectedSlots * stepMs,
      intervalMs: stepMs,
    },
  );

  return {
    candles,
    checked: closed,
    open,
    quarantined: quarantined
      .sort((a, b) => a.index - b.index)
      .map(({ record }) => record),
    missing,
    unjudged,
    duplicatesCollapsed,
    outOfOrder,
  };
}

/**
 * The slots `fromMs + k * intervalMs` below `toMs` that no open time in
 * `openTimesMs` fills, merged into maximal half-open ranges over open times.
 * It works for any regular series, such as the 5-minute metrics.
 */
export function missingRanges(
  openTimesMs: readonly number[],
  {
    fromMs,
    toMs,
    intervalMs: stepMs,
  }: { fromMs: number; toMs: number; intervalMs: number },
): MissingRange[] {
  requireSafeInteger(fromMs, 'fromMs');
  requireSafeInteger(toMs, 'toMs');
  if (requireSafeInteger(stepMs, 'intervalMs') <= 0) {
    throw new RangeError('intervalMs must be > 0');
  }
  if (fromMs > toMs) throw new RangeError('fromMs must not be after toMs');

  const present = [
    ...new Set(
      openTimesMs.filter(
        (time) =>
          Number.isSafeInteger(time) &&
          time >= fromMs &&
          time < toMs &&
          (time - fromMs) % stepMs === 0,
      ),
    ),
  ].sort((a, b) => a - b);

  const ranges: MissingRange[] = [];
  let cursor = fromMs;
  for (const time of present) {
    if (time > cursor) ranges.push({ fromMs: cursor, toMs: time });
    cursor = time + stepMs;
  }
  if (cursor < toMs) ranges.push({ fromMs: cursor, toMs });
  return ranges;
}

export type Freshness =
  | { readonly status: 'FRESH'; readonly ageMs: number }
  | { readonly status: 'STALE'; readonly ageMs: number }
  | {
      readonly status: 'UNKNOWN';
      readonly reason: 'no_data' | 'clock_skew';
    };

/**
 * How old the newest closed bar is at `asOfMs`. `ageMs` counts from the end
 * of the bar: a bar closing at `asOfMs - 1` has age 0.
 */
export function freshness(
  newestCloseMs: number | undefined,
  asOfMs: number,
  maxAgeMs: number,
): Freshness {
  requireSafeInteger(asOfMs, 'asOfMs');
  if (requireSafeInteger(maxAgeMs, 'maxAgeMs') <= 0) {
    throw new RangeError('maxAgeMs must be a safe integer > 0');
  }
  if (newestCloseMs === undefined)
    return { status: 'UNKNOWN', reason: 'no_data' };
  requireSafeInteger(newestCloseMs, 'newestCloseMs');
  if (newestCloseMs >= asOfMs) {
    return { status: 'UNKNOWN', reason: 'clock_skew' };
  }
  const ageMs = asOfMs - newestCloseMs - 1;
  return ageMs <= maxAgeMs
    ? { status: 'FRESH', ageMs }
    : { status: 'STALE', ageMs };
}

/** Anything but FRESH blocks entries (Rule 9). Exits are never blocked here. */
export function freshnessBlocksEntries(result: Freshness): boolean {
  return result.status !== 'FRESH';
}
