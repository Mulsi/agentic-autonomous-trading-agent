import {
  bigint,
  customType,
  doublePrecision,
  getTableConfig,
  numeric,
  pgTable,
  real,
  timestamp,
} from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';
import { nonSpecSources } from '../../fixtures/repo.js';
import {
  scanSource,
  scanTables,
  tablesIn,
} from '../../fixtures/schema-scan.js';

// Money is Decimal: numeric stays a string. Time is UTC: timestamptz, or epoch
// milliseconds in a number-mode bigint whose SQL name ends in `_ms`.

describe('the real schema follows the column conventions', () => {
  const tables = tablesIn(schema);

  it('scans every table exported from src/db/schema.ts', () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      'database_identity',
    ]);
  });

  it('has no banned column in the table metadata', () => {
    expect(scanTables(tables)).toEqual([]);
  });

  it('has no banned form in any source that imports drizzle-orm/pg-core', () => {
    const sources = nonSpecSources().filter(({ text }) =>
      text.includes('drizzle-orm/pg-core'),
    );

    expect(sources.map(({ path }) => path)).toContain('src/db/schema.ts');
    expect(sources.flatMap(({ path, text }) => scanSource(path, text))).toEqual(
      [],
    );
  });
});

describe('the scanner', () => {
  const unsafeNumber = customType<{ data: number; driverData: string }>({
    dataType: () => 'numeric',
    fromDriver: (value) => Number(value),
  });

  // One fixture table per banned form. The text is what a schema file would
  // hold, so the source layer is checked on the same forms.
  const banned = [
    {
      form: 'real',
      table: pgTable('fx_real', { price: real('price') }),
      text: "price: real('price'),",
    },
    {
      form: 'doublePrecision',
      table: pgTable('fx_double', { price: doublePrecision('price') }),
      text: "price: doublePrecision('price'),",
    },
    {
      form: 'numeric in number mode',
      table: pgTable('fx_numeric_number', {
        price: numeric('price', { mode: 'number' }),
      }),
      text: "price: numeric('price', { mode: 'number' }),",
    },
    {
      form: 'numeric in bigint mode',
      table: pgTable('fx_numeric_bigint', {
        price: numeric('price', { mode: 'bigint' }),
      }),
      text: "price: numeric('price', { mode: 'bigint' }),",
    },
    {
      form: 'bigint in number mode, not *_ms',
      table: pgTable('fx_bigint', {
        price: bigint('price', { mode: 'number' }),
      }),
      text: "price: bigint('price', { mode: 'number' }),",
    },
    {
      form: 'timestamp without time zone',
      table: pgTable('fx_timestamp', { price: timestamp('price') }),
      text: "price: timestamp('price'),",
    },
    {
      form: 'customType',
      table: pgTable('fx_custom', { price: unsafeNumber('price') }),
      text: "const unsafeNumber = customType<{ data: number }>({ dataType: () => 'numeric' });",
    },
  ];

  it.each(banned)(
    'fails on $form, naming the table and the column',
    ({ table }) => {
      const [violation, ...rest] = scanTables([table]);

      expect(rest).toEqual([]);
      expect(violation?.table).toBe(getTableConfig(table).name);
      expect(violation?.column).toBe('price');
    },
  );

  it.each(banned)('the source layer fails on $form too', ({ text }) => {
    expect(scanSource('fixture.ts', text)).not.toEqual([]);
  });

  it('passes numeric in string mode, timestamptz and bigint *_ms in number mode', () => {
    const allowed = pgTable('fx_allowed', {
      amount: numeric('amount'),
      amountString: numeric('amount_string', { mode: 'string' }),
      at: timestamp('at', { withTimezone: true }),
      atString: timestamp('at_string', { withTimezone: true, mode: 'string' }),
      createdMs: bigint('created_ms', { mode: 'number' }),
      count: bigint('count', { mode: 'bigint' }),
    });
    const text = [
      "amount: numeric('amount'),",
      "amountString: numeric('amount_string', { mode: 'string' }),",
      "at: timestamp('at', { withTimezone: true }),",
      "createdMs: bigint('created_ms', { mode: 'number' }),",
    ].join('\n');

    expect(scanTables([allowed])).toEqual([]);
    expect(scanSource('fixture.ts', text)).toEqual([]);
  });

  it('names the fixture table in the violation', () => {
    const table = pgTable('fx_named', { price: real('price') });

    expect(scanTables([table])).toEqual([
      { table: 'fx_named', column: 'price', rule: 'real returns a JS number' },
    ]);
  });

  it('finds tables among other exports', () => {
    const table = pgTable('fx_found', { amount: numeric('amount') });

    expect(tablesIn({ table, other: 1, text: 'x' })).toEqual([table]);
  });
});
