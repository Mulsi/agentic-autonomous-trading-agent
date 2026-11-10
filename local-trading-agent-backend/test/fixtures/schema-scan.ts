// The column conventions (S0e): money as `numeric` in string mode, time as
// `timestamptz` or epoch milliseconds in a number-mode `bigint` named `*_ms`.
// Two layers: Drizzle's table metadata for every exported table, and the source
// text of every file that declares columns, which also catches forms the
// metadata cannot see (an alias, or a column built but not exported).
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core';

export interface Violation {
  table: string;
  column: string;
  rule: string;
}

/** Epoch milliseconds: the only number-mode `bigint` columns allowed. */
const EPOCH_MS = /_ms$/;

function columnViolation(column: PgColumn): string | undefined {
  const kind = column.columnType;
  switch (kind) {
    case 'PgReal':
      return 'real returns a JS number';
    case 'PgDoublePrecision':
      return 'doublePrecision returns a JS number';
    case 'PgNumericNumber':
      return 'numeric in number mode returns a JS number';
    case 'PgNumericBigInt':
      return 'numeric in bigint mode returns a JS bigint';
    case 'PgBigInt53':
      return EPOCH_MS.test(column.name)
        ? undefined
        : 'number-mode bigint outside an *_ms column';
    case 'PgTimestamp':
    case 'PgTimestampString':
      return (column as PgColumn & { withTimezone: boolean }).withTimezone
        ? undefined
        : 'timestamp without time zone';
    case 'PgCustomColumn':
      return 'customType can hide a JS number';
    default:
      return undefined;
  }
}

/** Every exported value that is a Drizzle Postgres table. */
export function tablesIn(exports: Record<string, unknown>): PgTable[] {
  return Object.values(exports).filter((value): value is PgTable =>
    is(value, PgTable),
  );
}

/** Violations in the tables' metadata, naming the table and the column. */
export function scanTables(tables: readonly PgTable[]): Violation[] {
  return tables.flatMap((table) => {
    const { name, columns } = getTableConfig(table);
    return columns.flatMap((column) => {
      const rule = columnViolation(column);
      return rule === undefined
        ? []
        : [{ table: name, column: column.name, rule }];
    });
  });
}

/** The text without block and line comments, which may name banned forms. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
  for (const match of text.matchAll(/\btimestamp\s*\(([^)]*)\)/g)) {
    if (!/withTimezone\s*:\s*true/.test(match[1] ?? '')) {
      add(nameOf(match[1] ?? ''), 'timestamp without time zone');
    }
  }
  if (/\bcustomType\b/.test(text))
    add('(any)', 'customType can hide a JS number');
  return found;
}
