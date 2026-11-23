import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  date,
  doublePrecision,
  getTableConfig,
  integer,
  interval,
  json,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  point,
  real,
  serial,
  smallint,
  smallserial,
  text,
  timestamp,
  uuid,
  varchar,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';
import { nonSpecSources, readAppFile } from '../../fixtures/repo.js';
import {
  KNOWN_COLUMN_TYPES,
  scanSource,
  scanTables,
  SERVER_FILLED_EXEMPTIONS,
  tablesIn,
} from '../../fixtures/schema-scan.js';

// Money is Decimal: numeric stays a string. Time is UTC: timestamptz, or epoch
// milliseconds in a number-mode bigint whose SQL name ends in `_ms`.

describe('the real schema follows the column conventions', () => {
  const tables = tablesIn(schema);

  // S1b: the exact list, in export order.
  it('scans every table exported from src/db/schema.ts', () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      'database_identity',
      'assets',
      'candles',
      'market_data_quarantine',
    ]);
  });

  // S0f: the scan now also checks server-filled timestamptz precision, so the
  // real schema passes with its one pinned exemption (see below).
  it('has no banned column in the table metadata', () => {
    expect(scanTables(tables, SERVER_FILLED_EXEMPTIONS)).toEqual([]);
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

// S0f: the metadata layer is an allow-list; JSON, numeric-like arrays and
// integer epoch milliseconds are banned; server-filled timestamptz needs
// precision 0 to 3 (D12).

const mood = pgEnum('fx_mood', ['calm', 'busy']);

describe('the scanner: S0f bans', () => {
  const banned: {
    form: string;
    table: PgTable;
    text: string;
    column?: string;
  }[] = [
    {
      form: 'json',
      table: pgTable('fx_json', { price: json('price') }),
      text: "price: json('price'),",
    },
    {
      form: 'jsonb',
      table: pgTable('fx_jsonb', { price: jsonb('price') }),
      text: "price: jsonb('price'),",
    },
    {
      form: 'bigserial in number mode',
      table: pgTable('fx_bigserial', {
        price: bigserial('price', { mode: 'number' }),
      }),
      text: "price: bigserial('price', { mode: 'number' }),",
    },
    {
      form: 'integer on *_ms',
      table: pgTable('fx_integer_ms', { price: integer('price_ms') }),
      text: "price: integer('price_ms'),",
      column: 'price_ms',
    },
    {
      form: 'smallint on *_ms',
      table: pgTable('fx_smallint_ms', { price: smallint('price_ms') }),
      text: "price: smallint('price_ms'),",
      column: 'price_ms',
    },
    {
      form: 'serial on *_ms',
      table: pgTable('fx_serial_ms', { price: serial('price_ms') }),
      text: "price: serial('price_ms'),",
      column: 'price_ms',
    },
    {
      form: 'smallserial on *_ms',
      table: pgTable('fx_smallserial_ms', { price: smallserial('price_ms') }),
      text: "price: smallserial('price_ms'),",
      column: 'price_ms',
    },
    {
      form: 'a real array',
      table: pgTable('fx_real_array', { price: real('price').array() }),
      text: "price: real('price').array(),",
    },
    {
      form: 'a numeric array',
      table: pgTable('fx_numeric_array', { price: numeric('price').array() }),
      text: "price: numeric('price').array(),",
    },
    {
      form: 'a number-mode numeric array',
      table: pgTable('fx_numeric_number_array', {
        price: numeric('price', { mode: 'number' }).array(),
      }),
      text: "price: numeric('price', { mode: 'number' }).array(),",
    },
    {
      form: 'an integer array',
      table: pgTable('fx_integer_array', { price: integer('price').array() }),
      text: "price: integer('price').array(),",
    },
    {
      form: 'a timestamptz array',
      table: pgTable('fx_timestamp_array', {
        price: timestamp('price', { withTimezone: true }).array(),
      }),
      text: "price: timestamp('price', { withTimezone: true }).array(),",
    },
    {
      form: 'a nested real array',
      table: pgTable('fx_nested_array', {
        price: real('price').array().array(),
      }),
      text: "price: real('price').array().array(),",
    },
  ];

  it.each(banned)(
    'fails on $form with exactly one violation, naming the table and the column',
    ({ table, column }) => {
      const violations = scanTables([table]);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.table).toBe(getTableConfig(table).name);
      expect(violations[0]?.column).toBe(column ?? 'price');
    },
  );

  it.each(banned)('the source layer fails on $form too', ({ text: source }) => {
    expect(scanSource('fixture.ts', source)).not.toEqual([]);
  });

  it('names the base type of a banned array', () => {
    const table = pgTable('fx_named_array', {
      price: real('price').array().array(),
    });

    expect(scanTables([table])).toEqual([
      {
        table: 'fx_named_array',
        column: 'price',
        rule: 'array of PgReal: only text, varchar, char, uuid, boolean and enum arrays',
      },
    ]);
  });

  it.each([
    ['date', pgTable('fx_date', { price: date('price') }), 'PgDateString'],
    [
      'date in date mode',
      pgTable('fx_date_mode', { price: date('price', { mode: 'date' }) }),
      'PgDate',
    ],
    [
      'interval',
      pgTable('fx_interval', { price: interval('price') }),
      'PgInterval',
    ],
    ['point', pgTable('fx_point', { price: point('price') }), 'PgPointTuple'],
  ])(
    '%s is outside the allow-list, and the rule names its columnType',
    (_, table, kind) => {
      expect(scanTables([table])).toEqual([
        {
          table: getTableConfig(table).name,
          column: 'price',
          rule: `column type ${kind} is not on the allow-list`,
        },
      ]);
    },
  );

  it('fails closed on a columnType it has never seen', () => {
    const table = pgTable('fx_future', {
      price: text('price'),
      tags: text('tags').array(),
    });
    const stub = (column: PgColumn, kind: string): void => {
      Object.defineProperty(column, 'columnType', { value: kind });
    };
    expect(scanTables([table])).toEqual([]);

    stub(table.price, 'PgFutureType');
    stub(
      (table.tags as unknown as { baseColumn: PgColumn }).baseColumn,
      'PgText2',
    );

    expect(scanTables([table])).toEqual([
      {
        table: 'fx_future',
        column: 'price',
        rule: 'column type PgFutureType is not on the allow-list',
      },
      {
        table: 'fx_future',
        column: 'tags',
        rule: 'array of PgText2: only text, varchar, char, uuid, boolean and enum arrays',
      },
    ]);
  });

  it('every columnType the scan names exists in the installed drizzle-orm', () => {
    const t = pgTable('fx_every', {
      a: numeric('a'),
      b: bigint('b', { mode: 'bigint' }),
      c: bigserial('c', { mode: 'bigint' }),
      d: uuid('d'),
      e: boolean('e'),
      f: text('f'),
      g: varchar('g'),
      h: char('h'),
      i: mood('i'),
      j: integer('j'),
      k: smallint('k'),
      l: serial('l'),
      m: smallserial('m'),
      n: timestamp('n', { withTimezone: true }),
      o: timestamp('o', { withTimezone: true, mode: 'string' }),
      p: bigint('p_ms', { mode: 'number' }),
      q: text('q').array(),
      r: real('r'),
      s: doublePrecision('s'),
      u: numeric('u', { mode: 'number' }),
      v: numeric('v', { mode: 'bigint' }),
      w: json('w'),
      x: jsonb('x'),
      y: bigserial('y', { mode: 'number' }),
      z: customType<{ data: string }>({ dataType: () => 'text' })('z'),
    });
    const built = getTableConfig(t).columns.map((column) => column.columnType);

    expect([...new Set(built)].sort()).toEqual([...KNOWN_COLUMN_TYPES].sort());
  });
});

describe('the scanner: S0f allows', () => {
  it('integers for counts and ids, bigint-mode int8, text-like, enum and their arrays', () => {
    const table = pgTable('fx_allowed_s0f', {
      count: integer('count'),
      rank: smallint('rank'),
      id: serial('id'),
      small: smallserial('small_id'),
      big: bigserial('big_id', { mode: 'bigint' }),
      n: bigint('n', { mode: 'bigint' }),
      ref: uuid('ref'),
      flag: boolean('flag'),
      note: text('note'),
      code: varchar('code', { length: 8 }),
      side: char('side', { length: 1 }),
      state: mood('state'),
      tags: text('tags').array(),
      ids: uuid('ids').array(),
      flags: boolean('flags').array(),
      codes: varchar('codes').array(),
      moods: mood('moods').array(),
      grid: text('grid').array().array(),
    });
    const source = [
      "const mood = pgEnum('fx_mood', ['calm', 'busy']);",
      "count: integer('count'),",
      "rank: smallint('rank'),",
      "id: serial('id'),",
      "small: smallserial('small_id'),",
      "big: bigserial('big_id', { mode: 'bigint' }),",
      "n: bigint('n', { mode: 'bigint' }),",
      "ref: uuid('ref'),",
      "flag: boolean('flag'),",
      "note: text('note'),",
      "code: varchar('code', { length: 8 }),",
      "side: char('side', { length: 1 }),",
      "state: mood('state'),",
      "tags: text('tags').array(),",
      "ids: uuid('ids').array(),",
      "flags: boolean('flags').array(),",
      "codes: varchar('codes').notNull().array(),",
      "moods: mood('moods').array(),",
      "grid: text('grid').array().array(),",
      "typed: text('typed').$type<Side>()\n  .array(),",
    ].join('\n');

    expect(scanTables([table])).toEqual([]);
    expect(scanSource('fixture.ts', source)).toEqual([]);
  });

  it('the source layer fails closed on an .array() it cannot trace', () => {
    expect(scanSource('fixture.ts', 'tags: someBuilder.array(),')).not.toEqual(
      [],
    );
    expect(scanSource('fixture.ts', 'tags: pg.real("x").array(),')).not.toEqual(
      [],
    );
    expect(scanSource('fixture.ts', 'tags: build()("x").array(),')).not.toEqual(
      [],
    );
  });
});

describe('the scanner: server-filled timestamptz precision (D12)', () => {
  it.each([
    [
      'defaultNow()',
      pgTable('fx_now_default', {
        at: timestamp('at', { withTimezone: true }).defaultNow(),
      }),
    ],
    [
      'precision 6 with defaultNow()',
      pgTable('fx_now_six', {
        at: timestamp('at', { withTimezone: true, precision: 6 }).defaultNow(),
      }),
    ],
    [
      'default(sql`now()`)',
      pgTable('fx_now_sql', {
        at: timestamp('at', { withTimezone: true }).default(sql`now()`),
      }),
    ],
    [
      'string mode with defaultNow()',
      pgTable('fx_now_string', {
        at: timestamp('at', {
          withTimezone: true,
          mode: 'string',
        }).defaultNow(),
      }),
    ],
  ])('fails on %s, naming the table and the column', (_, table) => {
    const violations = scanTables([table]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      table: getTableConfig(table).name,
      column: 'at',
    });
    expect(violations[0]?.rule).toMatch(/precision 0 to 3/);
  });

  it('passes precision 3 or 0 with defaultNow(), no default, and $defaultFn', () => {
    const table = pgTable('fx_now_ok', {
      at3: timestamp('at3', { withTimezone: true, precision: 3 }).defaultNow(),
      at0: timestamp('at0', { withTimezone: true, precision: 0 }).defaultNow(),
      plain: timestamp('plain', { withTimezone: true }),
      js: timestamp('js', { withTimezone: true }).$defaultFn(() => new Date()),
    });

    expect(scanTables([table])).toEqual([]);
  });
});

describe('the server-filled exemption list', () => {
  const tables = tablesIn(schema);

  it('is exactly database_identity.created_at, with a reason', () => {
    expect(
      SERVER_FILLED_EXEMPTIONS.map(({ table, column }) => ({ table, column })),
    ).toEqual([{ table: 'database_identity', column: 'created_at' }]);
    for (const { reason } of SERVER_FILLED_EXEMPTIONS) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('without it, the real schema fails on that column', () => {
    expect(scanTables(tables)).toEqual([
      {
        table: 'database_identity',
        column: 'created_at',
        rule: 'server-filled timestamptz with an SQL default needs precision 0 to 3 (D12: µs against ms)',
      },
    ]);
  });

  it('an exemption naming a column that does not exist is itself a violation', () => {
    const stale = {
      table: 'database_identity',
      column: 'gone_at',
      reason: 'x',
    };

    expect(scanTables(tables, [...SERVER_FILLED_EXEMPTIONS, stale])).toEqual([
      {
        table: 'database_identity',
        column: 'gone_at',
        rule: 'stale exemption: no such server-filled timestamptz column',
      },
    ]);
  });

  it('an exemption for a column that already complies is stale too', () => {
    const table = pgTable('fx_complies', {
      at: timestamp('at', { withTimezone: true, precision: 3 }).defaultNow(),
    });

    expect(
      scanTables(
        [table],
        [{ table: 'fx_complies', column: 'at', reason: 'x' }],
      ),
    ).toEqual([
      {
        table: 'fx_complies',
        column: 'at',
        rule: 'stale exemption: no such server-filled timestamptz column',
      },
    ]);
  });

  it('src/db/schema.ts states the conventions it is held to', () => {
    const source = readAppFile('src/db/schema.ts');

    for (const needle of ['allow-list', 'json', 'array', 'precision', '_ms']) {
      expect(source).toContain(needle);
    }
  });
});
