import fc from 'fast-check';
import { decideIdentity } from '../../../src/db/identity.js';
import { markerReadFromRows } from '../../../src/db/marker-rows.js';
import { readAppFile } from '../../fixtures/repo.js';

// The marker rows are external data (Rule 11): checked with zod where they
// enter the app (D2). Anything but string markers is a failed read, which is
// UNKNOWN `unreadable`, never a crash and never a coerced marker.

const MARKER = '0b9f5a52-6c1e-4d8a-9f3b-2e7c4d1a8b60';

describe('markerReadFromRows', () => {
  it.each<[string, unknown[], string[]]>([
    ['no rows', [], []],
    ['one row', [{ marker: MARKER }], [MARKER]],
    ['two rows, in order', [{ marker: 'b' }, { marker: 'a' }], ['b', 'a']],
    ['an empty marker', [{ marker: '' }], ['']],
    ['whitespace, unchanged', [{ marker: ` ${MARKER}\n` }], [` ${MARKER}\n`]],
  ])('%s: rows with those markers', (_, rows, markers) => {
    expect(markerReadFromRows(rows)).toStrictEqual({ kind: 'rows', markers });
  });

  it.each<[string, unknown]>([
    ['a number', [{ marker: 7 }]],
    ['a bigint', [{ marker: 7n }]],
    ['null', [{ marker: null }]],
    ['undefined', [{ marker: undefined }]],
    ['true', [{ marker: true }]],
    ['an object', [{ marker: {} }]],
    ['an array', [{ marker: [] }]],
    ['a Buffer', [{ marker: Buffer.from('x') }]],
    ['no marker key', [{ other: MARKER }]],
    ['a null row', [null]],
    ['a string row', [MARKER]],
    [
      'one valid row next to an invalid one',
      [{ marker: MARKER }, { marker: 7 }],
    ],
    ['an invalid row next to a valid one', [{ marker: 7 }, { marker: MARKER }]],
    ['a non-array: an object', { marker: MARKER }],
    ['a non-array: a string', MARKER],
    ['a non-array: undefined', undefined],
    ['a non-array: null', null],
  ])('%s: a failed read with no sqlstate', (_, rows) => {
    const read = markerReadFromRows(rows);

    expect(read).toStrictEqual({ kind: 'failed' });
    expect(read).not.toHaveProperty('sqlstate');
    expect(decideIdentity(MARKER, read)).toStrictEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
    });
  });

  it('never throws, and passes exactly the string markers (fast-check)', () => {
    const row = fc.oneof(
      fc.anything(),
      fc.record({ marker: fc.anything() }),
      fc.record({ marker: fc.string() }),
    );

    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.array(row)), (rows) => {
        const read = markerReadFromRows(rows);
        const valid =
          Array.isArray(rows) &&
          rows.every(
            (r: unknown) =>
              typeof r === 'object' &&
              r !== null &&
              !Array.isArray(r) &&
              typeof (r as { marker?: unknown }).marker === 'string',
          );

        if (valid) {
          expect(read).toStrictEqual({
            kind: 'rows',
            markers: rows.map((r: { marker: string }) => r.marker),
          });
        } else {
          expect(read).toStrictEqual({ kind: 'failed' });
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('a row whose marker getter throws is a failed read, not a crash', () => {
    const hostile = {
      get marker(): string {
        throw new Error('getter');
      },
    };

    expect(markerReadFromRows([hostile])).toStrictEqual({ kind: 'failed' });
  });
});

describe('where the row check lives', () => {
  const rowCheck = readAppFile('src/db/marker-rows.ts');
  const client = readAppFile('src/db/client.ts');

  it('the row check imports zod, and no Nest, pg or drizzle-orm', () => {
    expect(rowCheck).toMatch(/^import \{ z \} from 'zod';$/m);
    expect(rowCheck).not.toMatch(/@nestjs\/|from\s+['"]pg['"]|drizzle-orm/);
  });

  it('the client hands the rows to it as unknown, with no type assertion on them', () => {
    expect(client).toContain(
      'const rows: unknown = (await client.query(query)).rows;',
    );
    expect(client).toContain('markerReadFromRows(rows)');
    expect(client).not.toMatch(/query<\s*\{\s*marker/);
    expect(client).not.toMatch(/as\s*\{\s*marker/);
    expect(client).not.toMatch(/\.rows\.map\(/);
  });
});
