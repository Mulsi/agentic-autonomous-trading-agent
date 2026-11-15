// The column conventions (S0e, S0f): money as `numeric` in string mode, time as
// `timestamptz` or epoch milliseconds in a number-mode `bigint` named `*_ms`,
// and nothing that reads a database value as a JS number by surprise.
//
// Two layers: Drizzle's table metadata for every exported table, and the source
// text of every file that declares columns, which also catches forms the
// metadata cannot see (an alias, or a column built but not exported).
//
// The metadata layer is an allow-list of Drizzle `columnType` values: a type it
// does not know is a violation, so a new or renamed type fails closed. The names
// are drizzle-orm 0.45's; schema-scan.spec.ts builds each one from the
// installed version.
import { is, SQL } from 'drizzle-orm';
import {
  getTableConfig,
  PgArray,
  PgTable,
  type PgColumn,
} from 'drizzle-orm/pg-core';

export interface Violation {
  table: string;
  column: string;
  rule: string;
}

/** A column let off the server-filled `precision` rule, with the reason. */
export interface Exemption {
  table: string;
  column: string;
  reason: string;
}

/** Epoch milliseconds: the only number-mode `bigint` columns allowed. */
const EPOCH_MS = /_ms$/;

/**
 * The one column exempt from the D12 rule. Pinned by schema-scan.spec.ts. A
 * new entry needs the same kind of reason, and a human.
 */
export const SERVER_FILLED_EXEMPTIONS: readonly Exemption[] = [
  {
    table: 'database_identity',
    column: 'created_at',
    reason:
      'Postgres fills it once, at the first migration; the app never reads or compares it (S0e round-1 quant note 1). A migration to timestamptz(3) would be a protected change for no gain.',
  },
];

/** Allowed as they are. */
const PLAIN_ALLOWED = new Set([
  'PgNumeric',
  'PgBigInt64',
  'PgBigSerial64',
  'PgUUID',
  'PgBoolean',
  'PgText',
  'PgVarchar',
  'PgChar',
  'PgEnumColumn',
]);

/** Counts and identifiers: exact in JS, but 32 bits cannot hold epoch ms. */
const INTEGERS = new Set([
  'PgInteger',
  'PgSmallInt',
  'PgSerial',
  'PgSmallSerial',
]);

/** The only element types an array may have, at any nesting depth. */
const ARRAY_ELEMENTS = new Set([
  'PgText',
  'PgVarchar',
  'PgChar',
  'PgUUID',
  'PgBoolean',
  'PgEnumColumn',
]);

const TIMESTAMPS = new Set(['PgTimestamp', 'PgTimestampString']);

/** Banned outright, each with its reason. */
const BANNED: Readonly<Record<string, string>> = {
  PgReal: 'real returns a JS number',
  PgDoublePrecision: 'doublePrecision returns a JS number',
  PgNumericNumber: 'numeric in number mode returns a JS number',
  PgNumericBigInt: 'numeric in bigint mode returns a JS bigint',
  PgJson: 'json: JSON.parse turns any number inside it into a JS number',
  PgJsonb: 'jsonb: JSON.parse turns any number inside it into a JS number',
  PgBigSerial53:
    'number-mode bigserial: an int8 read as a JS number outside an *_ms column',
  PgCustomColumn: 'customType can hide a JS number',
};

/** Every `columnType` the metadata layer knows, allowed or banned. */
export const KNOWN_COLUMN_TYPES: readonly string[] = [
  ...PLAIN_ALLOWED,
  ...INTEGERS,
  ...TIMESTAMPS,
  'PgBigInt53',
  'PgArray',
  ...Object.keys(BANNED),
];

type TimestampColumn = PgColumn & {
  withTimezone: boolean;
  precision: number | undefined;
};

/** The base element type of an array, through any nesting. */
function arrayElement(column: PgColumn): PgColumn {
  let base: PgColumn = column;
  while (is(base, PgArray)) base = base.baseColumn;
  return base;
}

/** The type rules, before the server-filled `precision` rule. */
function typeViolation(column: PgColumn): string | undefined {
  const kind = column.columnType;
  const banned = BANNED[kind];
  if (banned !== undefined) return banned;
  if (PLAIN_ALLOWED.has(kind)) return undefined;
  if (INTEGERS.has(kind)) {
    return EPOCH_MS.test(column.name)
      ? `${kind} on an *_ms column: 32 bits cannot hold epoch milliseconds`
      : undefined;
  }
  if (kind === 'PgBigInt53') {
    return EPOCH_MS.test(column.name)
      ? undefined
      : 'number-mode bigint outside an *_ms column';
  }
  if (TIMESTAMPS.has(kind)) {
    return (column as TimestampColumn).withTimezone
      ? undefined
      : 'timestamp without time zone';
  }
  if (kind === 'PgArray') {
    // `is` checks the class; columnType is what the allow-list reads. Both
    // must agree, or the array is something the scan does not understand.
    if (!is(column, PgArray)) return 'PgArray without a base column';
    const element = arrayElement(column).columnType;
    return ARRAY_ELEMENTS.has(element)
      ? undefined
      : `array of ${element}: only text, varchar, char, uuid, boolean and enum arrays`;
  }
  return `column type ${kind} is not on the allow-list`;
}

/**
 * D12: `now()` stores microseconds and every JS read keeps milliseconds, so a
 * server-filled `timestamptz` read into JS and compared back with `=` misses
 * its row. A server-side default needs `precision` 0 to 3. A `$defaultFn` is
 * filled in JS, in milliseconds, and is not a server default.
 */
function serverFilledViolation(column: PgColumn): string | undefined {
  if (!TIMESTAMPS.has(column.columnType)) return undefined;
  if (column.default === undefined) return undefined;
  const { precision } = column as TimestampColumn;
  if (precision !== undefined && precision >= 0 && precision <= 3) {
    return undefined;
  }
  const kind = is(column.default, SQL) ? 'an SQL default' : 'a server default';
  return `server-filled timestamptz with ${kind} needs precision 0 to 3 (D12: µs against ms)`;
}

/** Every exported value that is a Drizzle Postgres table. */
export function tablesIn(exports: Record<string, unknown>): PgTable[] {
  return Object.values(exports).filter((value): value is PgTable =>
    is(value, PgTable),
  );
}

/**
 * Violations in the tables' metadata, naming the table and the column. An
 * exemption lets one column off the server-filled `precision` rule only. An
 * exemption that matches no such violation in `tables` is itself a violation,
 * so a stale one cannot linger.
 */
export function scanTables(
  tables: readonly PgTable[],
  exemptions: readonly Exemption[] = [],
): Violation[] {
  const used = new Set<Exemption>();
  const found = tables.flatMap((table) => {
    const { name, columns } = getTableConfig(table);
    return columns.flatMap((column) => {
      const rules: string[] = [];
      const type = typeViolation(column);
      if (type !== undefined) rules.push(type);
      const serverFilled = serverFilledViolation(column);
      if (serverFilled !== undefined) {
        const exemption = exemptions.find(
          (entry) => entry.table === name && entry.column === column.name,
        );
        if (exemption === undefined) rules.push(serverFilled);
        else used.add(exemption);
      }
      return rules.map((rule) => ({ table: name, column: column.name, rule }));
    });
  });
  const stale = exemptions
    .filter((entry) => !used.has(entry))
    .map((entry) => ({
      table: entry.table,
      column: entry.column,
      rule: 'stale exemption: no such server-filled timestamptz column',
    }));
  return [...found, ...stale];
}

/** The text without block and line comments, which may name banned forms. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Builders whose `.array()` is allowed, besides a `pgEnum` builder. */
const ARRAY_BUILDERS = new Set(['text', 'varchar', 'char', 'uuid', 'boolean']);

/** The index of the bracket that opens the one closing at `close`, or -1. */
function openingBracket(text: string, close: number): number {
  const pairs: Record<string, string> = { ')': '(', '>': '<' };
  const closing = text[close] ?? '';
  const opening = pairs[closing];
  if (opening === undefined) return -1;
  let depth = 0;
  for (let at = close; at >= 0; at -= 1) {
    if (text[at] === closing) depth += 1;
    else if (text[at] === opening) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * The builder at the root of the call chain that ends just before `end`, as in
 * `text('x').notNull()` for `.array(`. Undefined when the text is not a plain
 * chain of calls, which the caller treats as a violation (fail closed).
 */
function chainRoot(text: string, end: number): string | undefined {
  let at = end - 1;
  for (;;) {
    while (at >= 0 && /\s/.test(text[at] ?? '')) at -= 1;
    if (text[at] !== ')') return undefined;
    at = openingBracket(text, at) - 1;
    if (at < 0) return undefined;
    while (at >= 0 && /\s/.test(text[at] ?? '')) at -= 1;
    // A generic call such as `$type<Price>()`.
    if (text[at] === '>') {
      at = openingBracket(text, at) - 1;
      if (at < 0) return undefined;
    }
    let start = at;
    while (start >= 0 && /[\w$]/.test(text[start] ?? '')) start -= 1;
    const name = text.slice(start + 1, at + 1);
    if (name === '') return undefined;
    at = start;
    while (at >= 0 && /\s/.test(text[at] ?? '')) at -= 1;
    if (text[at] !== '.') return name;
    at -= 1;
  }
}

/** Violations in the source text of a file that imports drizzle-orm/pg-core. */
export function scanSource(path: string, source: string): Violation[] {
  const text = withoutComments(source);
  const found: Violation[] = [];
  const add = (column: string, rule: string): void => {
    found.push({ table: path, column, rule });
  };
  const nameOf = (args: string): string =>
    /^\s*['"]([^'"]*)['"]/.exec(args)?.[1] ?? '(unnamed)';

  for (const match of text.matchAll(
    /\b(real|doublePrecision)\s*\(([^)]*)\)/g,
  )) {
    add(nameOf(match[2] ?? ''), `${match[1]} returns a JS number`);
  }
  for (const match of text.matchAll(/\b(numeric|decimal)\s*\(([^)]*)\)/g)) {
    const mode = /mode\s*:\s*['"](\w+)['"]/.exec(match[2] ?? '')?.[1];
    if (mode !== undefined && mode !== 'string') {
      add(nameOf(match[2] ?? ''), `${match[1]} in ${mode} mode`);
    }
  }
  for (const match of text.matchAll(/\bbigint\s*\(([^)]*)\)/g)) {
    const args = match[1] ?? '';
    if (
      /mode\s*:\s*['"]number['"]/.test(args) &&
      !EPOCH_MS.test(nameOf(args))
    ) {
      add(nameOf(args), 'number-mode bigint outside an *_ms column');
    }
  }
  for (const match of text.matchAll(/\bbigserial\s*\(([^)]*)\)/g)) {
    const args = match[1] ?? '';
    if (/mode\s*:\s*['"]number['"]/.test(args)) {
      add(nameOf(args), 'number-mode bigserial reads an int8 as a JS number');
    }
  }
  for (const match of text.matchAll(
    /\b(integer|smallint|serial|smallserial)\s*\(([^)]*)\)/g,
  )) {
    const name = nameOf(match[2] ?? '');
    if (EPOCH_MS.test(name)) {
      add(name, `${match[1]} cannot hold epoch milliseconds`);
    }
  }
  for (const match of text.matchAll(/\b(jsonb?)\s*\(([^)]*)\)/g)) {
    add(nameOf(match[2] ?? ''), `${match[1]} turns numbers into JS numbers`);
  }
  for (const match of text.matchAll(/\btimestamp\s*\(([^)]*)\)/g)) {
    if (!/withTimezone\s*:\s*true/.test(match[1] ?? '')) {
      add(nameOf(match[1] ?? ''), 'timestamp without time zone');
    }
  }
  const enums = new Set(
    [...text.matchAll(/\b([\w$]+)\s*=\s*pgEnum\s*\(/g)].map(
      (match) => match[1] ?? '',
    ),
  );
  for (const match of text.matchAll(/\.\s*array\s*\(/g)) {
    const root = chainRoot(text, match.index);
    if (root === undefined || !(ARRAY_BUILDERS.has(root) || enums.has(root))) {
      add(
        root ?? '(unparsed)',
        `.array() on ${root ?? 'an unparsed chain'}: only text, varchar, char, uuid, boolean and enum arrays`,
      );
    }
  }
  if (/\bcustomType\b/.test(text))
    add('(any)', 'customType can hide a JS number');
  return found;
}
