import { MAX_CHECKSUM_BYTES } from './bulk-limits.js';
import { isKlineInterval, type KlineInterval } from './normalizer.js';

// Names, URLs and CHECKSUM parsing for the public bulk-data archive (S1b).
// Pure: no I/O, clock or environment. Every argument is validated before any
// name or URL is built, and a URL is only ever a join of validated segments.

/** The one bulk-data origin, and the only URL in the app outside its settings. */
export const BINANCE_VISION_ORIGIN = 'https://data.binance.vision';

export type BulkPeriod = 'daily' | 'monthly';

/** Spot USDT pairs only (§2): upper-case letters and digits, then USDT. */
const SYMBOL = /^[A-Z0-9]{1,20}USDT$/;
const DAILY_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTHLY_DATE = /^([0-9]{4})-([0-9]{2})$/;

/**
 * The years a date may name. The archive starts in 2017, and the normalizer
 * reads timestamps from 2017 up to 2100 (D12).
 */
const FIRST_YEAR = 2017;
const LAST_YEAR = 2099;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A half-open UTC range of open times, `[fromMs, toMs)`. */
export interface PeriodRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface BulkFile {
  readonly symbol: string;
  readonly interval: KlineInterval;
  readonly period: BulkPeriod;
  /** `YYYY-MM-DD` for daily, `YYYY-MM` for monthly. */
  readonly date: string;
  readonly zipName: string;
  readonly checksumName: string;
  /** The only entry name the archive reader accepts. */
  readonly csvName: string;
  readonly zipUrl: string;
  readonly checksumUrl: string;
  readonly range: PeriodRange;
}

export function isBulkPeriod(value: unknown): value is BulkPeriod {
  return value === 'daily' || value === 'monthly';
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

/** Throws naming `symbol` unless it is a spot USDT pair. */
export function checkSymbol(symbol: unknown): string {
  const text = requireString(symbol, 'symbol');
  if (!SYMBOL.test(text)) {
    throw new RangeError(
      'symbol must be 1 to 20 upper-case letters or digits followed by USDT',
    );
  }
  return text;
}

/** Throws naming `interval` unless it is a slice 1 timeframe. */
export function checkInterval(interval: unknown): KlineInterval {
  if (!isKlineInterval(interval)) {
    throw new TypeError('interval must be one of 15m, 1h, 4h, 1d');
  }
  return interval;
}

/** Throws naming `period` unless it is daily or monthly. */
export function checkPeriod(period: unknown): BulkPeriod {
  if (!isBulkPeriod(period)) {
    throw new TypeError('period must be daily or monthly');
  }
  return period;
}

/**
 * The UTC range a date names in its period's format, or a RangeError naming
 * `name`. Daily is one day, monthly one calendar month.
 */
export function periodRange(
  period: BulkPeriod,
  date: unknown,
  name = 'date',
): PeriodRange {
  const text = requireString(date, name);
  const match = (period === 'daily' ? DAILY_DATE : MONTHLY_DATE).exec(text);
  if (match === null) {
    throw new RangeError(
      `${name} must be ${period === 'daily' ? 'YYYY-MM-DD' : 'YYYY-MM'} for a ${period} period`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12) {
    throw new RangeError(`${name} is not a valid ${period} date`);
  }
  const monthStart = Date.UTC(year, month - 1, 1);
  const nextMonth = Date.UTC(year, month, 1);
  if (period === 'monthly') return { fromMs: monthStart, toMs: nextMonth };

  const day = Number(match[3]);
  const daysInMonth = (nextMonth - monthStart) / DAY_MS;
  if (day < 1 || day > daysInMonth) {
    throw new RangeError(`${name} is not a valid ${period} date`);
  }
  const fromMs = monthStart + (day - 1) * DAY_MS;
  return { fromMs, toMs: fromMs + DAY_MS };
}

const pad = (value: number, width: number): string =>
  String(value).padStart(width, '0');

/** The days in a calendar month, by Date.UTC arithmetic: no local time zone. */
function daysIn(year: number, month: number): number {
  return (Date.UTC(year, month, 1) - Date.UTC(year, month - 1, 1)) / DAY_MS;
}

/** The archive names and URLs for one period. Validates every argument first. */
export function bulkFile(
  symbol: unknown,
  interval: unknown,
  period: unknown,
  date: unknown,
): BulkFile {
  const checkedSymbol = checkSymbol(symbol);
  const checkedInterval = checkInterval(interval);
  const checkedPeriod = checkPeriod(period);
  const range = periodRange(checkedPeriod, date);
  const checkedDate = date as string;

  const stem = `${checkedSymbol}-${checkedInterval}-${checkedDate}`;
  const zipName = `${stem}.zip`;
  const checksumName = `${zipName}.CHECKSUM`;
  const directory = [
    BINANCE_VISION_ORIGIN,
    'data',
    'spot',
    checkedPeriod,
    'klines',
    checkedSymbol,
    checkedInterval,
  ].join('/');
  return {
    symbol: checkedSymbol,
    interval: checkedInterval,
    period: checkedPeriod,
    date: checkedDate,
    zipName,
    checksumName,
    csvName: `${stem}.csv`,
    zipUrl: `${directory}/${zipName}`,
    checksumUrl: `${directory}/${checksumName}`,
    range,
  };
}

/**
 * Every period from `from` to `to`, inclusive, ascending. `from` after `to` is
 * a RangeError, raised before any file is listed.
 */
export function filesFor(
  symbol: unknown,
  interval: unknown,
  period: unknown,
  from: unknown,
  to: unknown,
): BulkFile[] {
  checkSymbol(symbol);
  checkInterval(interval);
  const checkedPeriod = checkPeriod(period);
  const first = periodRange(checkedPeriod, from, 'from');
  const last = periodRange(checkedPeriod, to, 'to');
  if (first.fromMs > last.fromMs) {
    throw new RangeError('from must not be after to');
  }
  const files: BulkFile[] = [];
  const parts = (from as string).split('-').map(Number);
  let year = parts[0] as number;
  let month = parts[1] as number;
  let day = parts[2] ?? 1;
  while (Date.UTC(year, month - 1, day) <= last.fromMs) {
    const date =
      checkedPeriod === 'monthly'
        ? `${pad(year, 4)}-${pad(month, 2)}`
        : `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
    files.push(bulkFile(symbol, interval, checkedPeriod, date));
    if (checkedPeriod === 'daily' && day < daysIn(year, month)) {
      day += 1;
      continue;
    }
    day = 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return files;
}

export type ChecksumResult =
  | { readonly ok: true; readonly sha256: string }
  | {
      readonly ok: false;
      readonly reason: 'too_large' | 'empty' | 'bad_format' | 'wrong_name';
    };

/** `<64 lower-case hex><one or two spaces><name>`. */
const CHECKSUM_LINE = /^([0-9a-f]{64}) {1,2}([^\n\r]*)$/;

/**
 * Reads a published CHECKSUM file: one line, optionally ending in `\n`, that
 * names exactly `expectedZipName`. Anything else fails; the text is data.
 */
export function parseChecksum(
  text: string,
  expectedZipName: string,
): ChecksumResult {
  if (new TextEncoder().encode(text).length > MAX_CHECKSUM_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (line === '') return { ok: false, reason: 'empty' };
  const match = CHECKSUM_LINE.exec(line);
  if (match === null) return { ok: false, reason: 'bad_format' };
  if (match[2] !== expectedZipName) return { ok: false, reason: 'wrong_name' };
  return { ok: true, sha256: match[1] as string };
}
