import { MAX_LINE_BYTES } from './bulk-limits.js';
import { normalizeEpoch } from './normalizer.js';

// Splits a bulk kline CSV into lines and fields (S1b). Pure: no I/O, clock or
// environment. Only structural faults reject the whole file; row content is
// judged row by row by the validator, which quarantines what it cannot read.

/** The documented Binance spot kline header. Only an exact match is skipped. */
export const BINANCE_KLINE_HEADER =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

export interface CsvLine {
  /** The 0-based line index in the CSV, header included. */
  readonly index: number;
  /** The line exactly as it was, without its `\n`. Data, never instructions. */
  readonly text: string;
  /** `text.split(',')`. The validator receives this array itself. */
  readonly fields: readonly string[];
}

export type CsvRejectReason =
  'bad_encoding' | 'nul_byte' | 'line_too_long' | 'too_many_rows';

export type SplitResult =
  | {
      readonly ok: true;
      readonly header: boolean;
      readonly lines: readonly CsvLine[];
    }
  | { readonly ok: false; readonly reason: CsvRejectReason };

const NEWLINE = 0x0a;

/**
 * Splits the CSV bytes on `\n`. One empty final line (the trailing newline) is
 * dropped; every other line is a row, an empty one included. The first line is
 * skipped as the header only when it equals `BINANCE_KLINE_HEADER` exactly.
 *
 * Rejects the whole file when the bytes are not UTF-8, hold a NUL, have a line
 * over `MAX_LINE_BYTES`, or have more than `2 * expectedSlots + 1` lines.
 */
export function splitBulkCsv(
  bytes: Uint8Array,
  expectedSlots: number,
): SplitResult {
  if (!Number.isSafeInteger(expectedSlots) || expectedSlots < 0) {
    throw new RangeError('expectedSlots must be a safe integer >= 0');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }
  if (text.includes('\0')) return { ok: false, reason: 'nul_byte' };

  // Line lengths in bytes, counted on the bytes themselves.
  let lineCount = 0;
  let lineStart = 0;
  for (let at = 0; at <= bytes.length; at += 1) {
    if (at === bytes.length || bytes[at] === NEWLINE) {
      if (at - lineStart > MAX_LINE_BYTES) {
        return { ok: false, reason: 'line_too_long' };
      }
      // The empty piece after a final newline is not a line.
      if (!(at === bytes.length && at === lineStart)) lineCount += 1;
      lineStart = at + 1;
    }
  }
  if (lineCount > 2 * expectedSlots + 1) {
    return { ok: false, reason: 'too_many_rows' };
  }

  const pieces = text.split('\n');
  if (pieces.at(-1) === '') pieces.pop();
  const header = pieces[0] === BINANCE_KLINE_HEADER;
  const lines: CsvLine[] = [];
  pieces.forEach((line, index) => {
    if (header && index === 0) return;
    lines.push({ index, text: line, fields: line.split(',') });
  });
  return { ok: true, header, lines };
}

export interface TimeUnits {
  readonly us: number;
  readonly ms: number;
  readonly unreadable: number;
}

/** How the data rows give their open time (D12): µs, ms, or neither. */
export function timeUnits(lines: readonly CsvLine[]): TimeUnits {
  let us = 0;
  let ms = 0;
  let unreadable = 0;
  for (const line of lines) {
    const epoch = normalizeEpoch(line.fields[0]);
    if (!epoch.ok) unreadable += 1;
    else if (epoch.unit === 'us') us += 1;
    else ms += 1;
  }
  return { us, ms, unreadable };
}
