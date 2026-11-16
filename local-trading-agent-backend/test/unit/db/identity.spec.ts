import fc from 'fast-check';
import {
  blocksEntries,
  decideIdentity,
  identityLogFields,
  markerReadFailure,
  type DatabaseIdentity,
  type IdentityStatus,
  type IdentityUnknownReason,
  type MarkerRead,
} from '../../../src/db/identity.js';
import { readAppFile } from '../../fixtures/repo.js';

const MARKER = '0b9f5a52-6c1e-4d8a-9f3b-2e7c4d1a8b60';
const OTHER = 'c4a1e2f3-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const one = (marker: string): MarkerRead => ({
  kind: 'rows',
  markers: [marker],
});

describe('decideIdentity', () => {
  it.each<[string, string | undefined, MarkerRead, DatabaseIdentity]>([
    [
      'unset setting',
      undefined,
      one(MARKER),
      { status: 'UNKNOWN', reason: 'not_configured', marker: MARKER },
    ],
    [
      'empty setting',
      '',
      one(MARKER),
      { status: 'UNKNOWN', reason: 'not_configured', marker: MARKER },
    ],
    [
      'blank setting',
      ' \t\n',
      one(MARKER),
      { status: 'UNKNOWN', reason: 'not_configured', marker: MARKER },
    ],
    [
      'unset setting, no table',
      undefined,
      { kind: 'no_table' },
      { status: 'UNKNOWN', reason: 'not_configured' },
    ],
    [
      'no table',
      MARKER,
      { kind: 'no_table' },
      { status: 'UNKNOWN', reason: 'missing_marker' },
    ],
    [
      'no row',
      MARKER,
      { kind: 'rows', markers: [] },
      { status: 'UNKNOWN', reason: 'missing_marker' },
    ],
    [
      'another marker',
      MARKER,
      one(OTHER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: OTHER },
    ],
    [
      'upper case',
      MARKER.toUpperCase(),
      one(MARKER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: MARKER },
    ],
    [
      'leading space',
      ` ${MARKER}`,
      one(MARKER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: MARKER },
    ],
    [
      'trailing newline',
      `${MARKER}\n`,
      one(MARKER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: MARKER },
    ],
    [
      'a prefix of the marker',
      MARKER.slice(0, 8),
      one(MARKER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: MARKER },
    ],
    [
      'the marker extended',
      `${MARKER}0`,
      one(MARKER),
      { status: 'UNKNOWN', reason: 'mismatch', marker: MARKER },
    ],
    [
      'a failed read',
      MARKER,
      { kind: 'failed' },
      { status: 'UNKNOWN', reason: 'unreadable' },
    ],
    [
      'two rows',
      MARKER,
      { kind: 'rows', markers: [MARKER, OTHER] },
      { status: 'UNKNOWN', reason: 'unreadable' },
    ],
    [
      'an exact match',
      MARKER,
      one(MARKER),
      { status: 'VERIFIED', marker: MARKER },
    ],
  ])('%s', (_, expected, read, result) => {
    expect(decideIdentity(expected, read)).toEqual(result);
  });

  it('is VERIFIED exactly when configured and equal to the single stored marker', () => {
    const value = fc.oneof(
      fc.uuid(),
      fc.string({ unit: 'binary', maxLength: 40 }),
      fc.constantFrom('', ' ', MARKER, MARKER.toUpperCase(), ` ${MARKER}`),
    );
    const read: fc.Arbitrary<MarkerRead> = fc.oneof(
      fc.constant<MarkerRead>({ kind: 'no_table' }),
      fc.constant<MarkerRead>({ kind: 'failed' }),
      fc
        .array(value, { maxLength: 3 })
        .map((markers) => ({ kind: 'rows' as const, markers })),
    );

    fc.assert(
      fc.property(
        fc.option(value, { nil: undefined }),
        read,
        (expected, marker) => {
          const configured = expected !== undefined && expected.trim() !== '';
          const single =
            marker.kind === 'rows' && marker.markers.length === 1
              ? marker.markers[0]
              : undefined;
          const result = decideIdentity(expected, marker);

          expect(result.status === 'VERIFIED').toBe(
            configured && single !== undefined && single === expected,
          );
          expect(result.marker).toBe(single);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('blocksEntries', () => {
  it.each<IdentityUnknownReason>([
    'not_configured',
    'missing_marker',
    'mismatch',
    'unreadable',
  ])('blocks for UNKNOWN %s', (reason) => {
    expect(blocksEntries({ status: 'UNKNOWN', reason })).toBe(true);
    expect(blocksEntries({ status: 'UNKNOWN', reason, marker: MARKER })).toBe(
      true,
    );
  });

  it('does not block for VERIFIED', () => {
    expect(blocksEntries({ status: 'VERIFIED', marker: MARKER })).toBe(false);
  });

  it('blocks for any status it does not know', () => {
    const corrupt = {
      status: 'verified',
      marker: MARKER,
    } as unknown as DatabaseIdentity;

    expect(blocksEntries(corrupt)).toBe(true);
  });

  it('types the status and the reason as exact unions', () => {
    expectTypeOf<IdentityStatus>().toEqualTypeOf<'VERIFIED' | 'UNKNOWN'>();
    expectTypeOf<DatabaseIdentity['status']>().toEqualTypeOf<IdentityStatus>();
    expectTypeOf<IdentityUnknownReason>().toEqualTypeOf<
      'not_configured' | 'missing_marker' | 'mismatch' | 'unreadable'
    >();
  });
});

describe('markerReadFailure', () => {
  it('reads undefined_table (42P01) as no table', () => {
    expect(markerReadFailure({ code: '42P01' })).toEqual({ kind: 'no_table' });
  });

  // S0f: a failed read now keeps a well-formed SQLSTATE, so the first two
  // cases carry it. Each case still reads as a failed read.
  it.each<[string, unknown, MarkerRead]>([
    [
      'permission denied',
      { code: '42501' },
      { kind: 'failed', sqlstate: '42501' },
    ],
    [
      'an undefined column',
      { code: '42703' },
      { kind: 'failed', sqlstate: '42703' },
    ],
    ['a read timeout', new Error('Query read timeout'), { kind: 'failed' }],
    [
      'a dropped connection',
      new Error('Connection terminated unexpectedly'),
      { kind: 'failed' },
    ],
    ['a non-error', 'boom', { kind: 'failed' }],
    ['null', null, { kind: 'failed' }],
  ])('reads %s as a failed read', (_, error, read) => {
    expect(markerReadFailure(error)).toStrictEqual(read);
  });
});

describe('markerReadFailure keeps a well-formed SQLSTATE (S0f)', () => {
  it.each(['XX000', '22012', '57P01', '42501'])(
    'keeps %s as sqlstate',
    (code) => {
      expect(markerReadFailure({ code })).toStrictEqual({
        kind: 'failed',
        sqlstate: code,
      });
      expect(
        markerReadFailure(Object.assign(new Error('boom'), { code })),
      ).toStrictEqual({ kind: 'failed', sqlstate: code });
    },
  );

  it.each<[string, unknown]>([
    [
      'a Node error code',
      Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    ],
    ["pg's read timeout, which has no code", new Error('Query read timeout')],
    ['no code', {}],
    ['a numeric code', { code: 22012 }],
    ['lower case', { code: 'xx000' }],
    ['four characters', { code: 'XX00' }],
    ['six characters', { code: 'XX0000' }],
    ['a quote inside', { code: 'XX00"' }],
    ['a trailing newline', { code: 'XX000\n' }],
    ['null', null],
    ['a string thrown as the error', 'XX000'],
    ['undefined', undefined],
  ])('leaves sqlstate out for %s', (_, error) => {
    const read = markerReadFailure(error);

    expect(read).toStrictEqual({ kind: 'failed' });
    expect(read).not.toHaveProperty('sqlstate');
  });

  it('still reads 42P01 as no_table, with no sqlstate', () => {
    expect(markerReadFailure({ code: '42P01' })).toStrictEqual({
      kind: 'no_table',
    });
  });

  it('a code getter that throws is a failed read, not a crash', () => {
    const hostile = {
      get code(): string {
        throw new Error('getter');
      },
    };

    expect(markerReadFailure(hostile)).toStrictEqual({ kind: 'failed' });
  });

  it('has sqlstate exactly when code is a 5-character SQLSTATE other than 42P01', () => {
    const code = fc.oneof(
      fc.anything(),
      fc.string({ minLength: 4, maxLength: 6 }),
      fc.stringMatching(/^[0-9A-Z]{5}$/),
      fc.stringMatching(/^[0-9A-Za-z"\n ]{5}$/),
      fc.constantFrom('42P01', 'XX000', 'ECONNRESET', '42p01'),
    );

    fc.assert(
      fc.property(code, (value) => {
        const read = markerReadFailure({ code: value });
        const wellFormed =
          typeof value === 'string' &&
          /^[0-9A-Z]{5}$/.test(value) &&
          value !== '42P01';

        expect('sqlstate' in read).toBe(wellFormed);
        if (wellFormed) {
          expect(read).toStrictEqual({ kind: 'failed', sqlstate: value });
        }
        if (value === '42P01') expect(read).toStrictEqual({ kind: 'no_table' });
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('decideIdentity carries sqlstate on unreadable only (S0f)', () => {
  it('copies sqlstate onto UNKNOWN unreadable', () => {
    expect(
      decideIdentity(MARKER, { kind: 'failed', sqlstate: 'XX000' }),
    ).toStrictEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
      sqlstate: 'XX000',
    });
  });

  it('leaves it out when the failed read has none', () => {
    const identity = decideIdentity(MARKER, { kind: 'failed' });

    expect(identity).toStrictEqual({ status: 'UNKNOWN', reason: 'unreadable' });
    expect(identity).not.toHaveProperty('sqlstate');
  });

  it('gives not_configured, with no sqlstate, when no marker is configured', () => {
    for (const expected of [undefined, '', ' ']) {
      const identity = decideIdentity(expected, {
        kind: 'failed',
        sqlstate: 'XX000',
      });

      expect(identity).toStrictEqual({
        status: 'UNKNOWN',
        reason: 'not_configured',
      });
    }
  });

  it('no result but unreadable ever carries sqlstate, over every MarkerRead shape', () => {
    const value = fc.oneof(
      fc.uuid(),
      fc.string({ maxLength: 20 }),
      fc.constant(MARKER),
    );
    const read: fc.Arbitrary<MarkerRead> = fc.oneof(
      fc.constant<MarkerRead>({ kind: 'no_table' }),
      fc.constant<MarkerRead>({ kind: 'failed' }),
      fc
        .stringMatching(/^[0-9A-Z]{5}$/)
        .map((sqlstate): MarkerRead => ({ kind: 'failed', sqlstate })),
      fc
        .array(value, { maxLength: 3 })
        .map((markers): MarkerRead => ({ kind: 'rows', markers })),
    );

    fc.assert(
      fc.property(fc.option(value, { nil: undefined }), read, (expected, r) => {
        const identity = decideIdentity(expected, r);
        const carries = 'sqlstate' in identity;

        if (identity.status === 'UNKNOWN' && identity.reason === 'unreadable') {
          expect(carries).toBe(r.kind === 'failed' && r.sqlstate !== undefined);
          if (carries && r.kind === 'failed') {
            expect(identity.sqlstate).toBe(r.sqlstate);
          }
        } else {
          expect(carries).toBe(false);
        }
        expect('sqlstate' in identityLogFields(identity)).toBe(carries);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('identityLogFields', () => {
  it('carries status, reason and the stored marker', () => {
    expect(
      identityLogFields({
        status: 'UNKNOWN',
        reason: 'mismatch',
        marker: MARKER,
      }),
    ).toEqual({ status: 'UNKNOWN', reason: 'mismatch', marker: MARKER });
    expect(
      identityLogFields({ status: 'UNKNOWN', reason: 'missing_marker' }),
    ).toEqual({ status: 'UNKNOWN', reason: 'missing_marker' });
    expect(identityLogFields({ status: 'VERIFIED', marker: MARKER })).toEqual({
      status: 'VERIFIED',
      marker: MARKER,
    });
  });

  it('adds sqlstate when the identity has one, and leaves it out otherwise (S0f)', () => {
    expect(
      identityLogFields({
        status: 'UNKNOWN',
        reason: 'unreadable',
        sqlstate: 'XX000',
      }),
    ).toStrictEqual({
      status: 'UNKNOWN',
      reason: 'unreadable',
      sqlstate: 'XX000',
    });
    expect(
      identityLogFields({ status: 'UNKNOWN', reason: 'unreadable' }),
    ).toStrictEqual({ status: 'UNKNOWN', reason: 'unreadable' });
    expect(
      identityLogFields({ status: 'VERIFIED', marker: MARKER }),
    ).not.toHaveProperty('sqlstate');
    expect(
      identityLogFields({ status: 'UNKNOWN', reason: 'missing_marker' }),
    ).not.toHaveProperty('sqlstate');
  });
});

describe('src/db/identity.ts stays pure', () => {
  const source = readAppFile('src/db/identity.ts');

  it.each([
    ['@nestjs/', /@nestjs\//],
    ['pg', /from\s+['"]pg['"]|require\(\s*['"]pg['"]|import\(\s*['"]pg['"]/],
    ['drizzle-orm', /drizzle-orm/],
    ['process.', /process\./],
  ])('has no %s', (_, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it('imports nothing at all', () => {
    expect(source).not.toMatch(/^\s*import\b|\brequire\(/m);
  });

  it('returns VERIFIED from exactly one place', () => {
    expect(source.match(/\{ status: 'VERIFIED'/g)).toHaveLength(1);
  });
});
