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

  it.each([
    ['permission denied', { code: '42501' }],
    ['an undefined column', { code: '42703' }],
    ['a read timeout', new Error('Query read timeout')],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    ['a non-error', 'boom'],
    ['null', null],
  ])('reads %s as a failed read', (_, error) => {
    expect(markerReadFailure(error)).toEqual({ kind: 'failed' });
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
