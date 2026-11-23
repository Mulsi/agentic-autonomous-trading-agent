import {
  BINANCE_KLINE_HEADER,
  splitBulkCsv,
  timeUnits,
} from '../../../src/market-data/bulk-csv.js';
import { MAX_LINE_BYTES } from '../../../src/market-data/bulk-limits.js';
import { validateKlines } from '../../../src/market-data/validator.js';
import {
  ANCHOR_MS,
  FIFTEEN_MINUTES_MS,
} from '../../fixtures/market-data/klines.js';
import { readFixture } from '../../fixtures/market-data/bulk.js';

// S1b criteria 5 to 7, over the committed 8-row S1a fixture.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const EIGHT = readFixture('btcusdt-15m-2026-10-01.csv');
const SLOTS = 96;

function split(text: string, slots = SLOTS) {
  const result = splitBulkCsv(encode(text), slots);
  if (!result.ok) throw new Error(`rejected: ${result.reason}`);
  return result;
}

function validate(lines: ReturnType<typeof split>['lines']) {
  return validateKlines(
    lines.map((line) => line.fields),
    {
      symbol: 'BTCUSDT',
      interval: '15m',
      range: { fromMs: ANCHOR_MS, toMs: ANCHOR_MS + 96 * FIFTEEN_MINUTES_MS },
      asOfMs: ANCHOR_MS + 96 * FIFTEEN_MINUTES_MS,
      outlier: { window: 4, maxRangeMultiple: 1000 },
    },
  );
}

describe('the 8-row fixture (criterion 5)', () => {
  it('gives 8 lines of 12 fields, no header, and µs times', () => {
    const result = split(EIGHT);

    expect(result.header).toBe(false);
    expect(result.lines).toHaveLength(8);
    for (const [index, line] of result.lines.entries()) {
      expect(line.index).toBe(index);
      expect(line.fields).toHaveLength(12);
      expect(line.fields).toEqual(line.text.split(','));
    }
    expect(result.lines.map((line) => line.text).join('\n') + '\n').toBe(EIGHT);
    expect(timeUnits(result.lines)).toEqual({ us: 8, ms: 0, unreadable: 0 });
  });

  it('counts ms and unreadable open times', () => {
    const result = split('1790812800000,x\nnope,x\n1790812800000000,x\n');

    expect(timeUnits(result.lines)).toEqual({ us: 1, ms: 1, unreadable: 1 });
  });
});

describe('the header (criterion 6)', () => {
  it('skips the documented header and keeps the 8 rows', () => {
    const result = split(`${BINANCE_KLINE_HEADER}\n${EIGHT}`);

    expect(result.header).toBe(true);
    expect(result.lines).toHaveLength(8);
    expect(result.lines[0]?.index).toBe(1);
  });

  it.each([
    [
      'one name changed',
      BINANCE_KLINE_HEADER.replace('quote_volume', 'quote_vol'),
    ],
    ['a trailing carriage return', `${BINANCE_KLINE_HEADER}\r`],
    ['upper case', BINANCE_KLINE_HEADER.toUpperCase()],
    ['a byte-order mark', `\uFEFF${BINANCE_KLINE_HEADER}`],
  ])(
    'keeps a header with %s as a data row, quarantined at index 0',
    (_, header) => {
      const result = split(`${header}\n${EIGHT}`);

      expect(result.header).toBe(false);
      expect(result.lines).toHaveLength(9);
      expect(result.lines[0]?.text).toBe(header);

      const batch = validate(result.lines);
      expect(batch.quarantined).toHaveLength(1);
      expect(['malformed_row', 'bad_timestamp']).toContain(
        batch.quarantined[0]?.reason,
      );
      expect(batch.quarantined[0]?.raw).toBe(result.lines[0]?.fields);
      expect(batch.candles).toHaveLength(8);
    },
  );

  it('treats a header on a later line as a data row', () => {
    const [first, ...rest] = EIGHT.split('\n');
    const result = split(
      `${first}\n${BINANCE_KLINE_HEADER}\n${rest.join('\n')}`,
    );

    expect(result.header).toBe(false);
    expect(result.lines).toHaveLength(9);
    expect(result.lines[1]?.text).toBe(BINANCE_KLINE_HEADER);
    const batch = validate(result.lines);
    expect(batch.quarantined.map((record) => record.raw)).toEqual([
      result.lines[1]?.fields,
    ]);
  });
});

describe('file-level rejections (criterion 7)', () => {
  it('rejects invalid UTF-8 as bad_encoding', () => {
    const bytes = Uint8Array.from([...encode(EIGHT), 0xc3, 0x28, 0x0a]);

    expect(splitBulkCsv(bytes, SLOTS)).toEqual({
      ok: false,
      reason: 'bad_encoding',
    });
  });

  it('rejects a NUL byte as nul_byte', () => {
    expect(splitBulkCsv(encode(`${EIGHT}1,2\0,3\n`), SLOTS)).toEqual({
      ok: false,
      reason: 'nul_byte',
    });
  });

  it('rejects a 1025-byte line and accepts a 1024-byte one', () => {
    expect(MAX_LINE_BYTES).toBe(1024);
    const long = 'x'.repeat(MAX_LINE_BYTES + 1);
    const fits = 'x'.repeat(MAX_LINE_BYTES);

    expect(splitBulkCsv(encode(`${EIGHT}${long}\n`), SLOTS)).toEqual({
      ok: false,
      reason: 'line_too_long',
    });
    expect(splitBulkCsv(encode(`${EIGHT}${long}`), SLOTS)).toEqual({
      ok: false,
      reason: 'line_too_long',
    });
    const accepted = split(`${EIGHT}${fits}\n`);
    expect(accepted.lines.at(-1)?.text).toBe(fits);
  });

  it('counts line length in bytes, not characters', () => {
    // 512 two-byte characters are 1024 bytes; one more is 1026.
    expect(split(`${'é'.repeat(512)}\n`).lines).toHaveLength(1);
    expect(splitBulkCsv(encode(`${'é'.repeat(513)}\n`), SLOTS)).toEqual({
      ok: false,
      reason: 'line_too_long',
    });
  });

  it('rejects 2 × expectedSlots + 2 lines and accepts 2 × expectedSlots + 1', () => {
    const slots = 4;
    const lines = (count: number): string => 'row\n'.repeat(count);

    expect(splitBulkCsv(encode(lines(2 * slots + 2)), slots)).toEqual({
      ok: false,
      reason: 'too_many_rows',
    });
    expect(split(lines(2 * slots + 1), slots).lines).toHaveLength(9);
    expect(
      split(`${BINANCE_KLINE_HEADER}\n${lines(2 * slots)}`, slots).lines,
    ).toHaveLength(8);
  });

  it('keeps an empty line in the middle as a row, and drops one trailing newline', () => {
    const [first, ...rest] = EIGHT.split('\n');
    const result = split(`${first}\n\n${rest.join('\n')}`);

    expect(result.lines).toHaveLength(9);
    expect(result.lines[1]).toEqual({ index: 1, text: '', fields: [''] });
    expect(validate(result.lines).quarantined.map((r) => r.reason)).toEqual([
      'malformed_row',
    ]);

    expect(split(EIGHT.slice(0, -1)).lines).toHaveLength(8);
    expect(split(`${EIGHT}\n`).lines).toHaveLength(9);
  });

  it('gives no lines for an empty file', () => {
    expect(splitBulkCsv(new Uint8Array(0), SLOTS)).toEqual({
      ok: true,
      header: false,
      lines: [],
    });
  });
});
