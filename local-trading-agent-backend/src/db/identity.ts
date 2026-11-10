// Which database is this? Every checkout publishes Postgres on the same port,
// so a leftover worktree database or an empty volume after a folder rename can
// answer in place of the real one. There the 48-entry counter would read 0 and
// a latched kill switch would be missing. Each database carries a marker that
// Postgres generated when it was first migrated, and the app compares it with
// the DATABASE_IDENTITY setting at boot.
//
// Pure: no Nest, no driver, no environment. The boot reads the marker and hands
// the read to `decideIdentity`. Anything but an exact match is UNKNOWN, which
// blocks entries (S7a) and never stops the process, so exits keep running.

export type IdentityStatus = 'VERIFIED' | 'UNKNOWN';

export type IdentityUnknownReason =
  'not_configured' | 'missing_marker' | 'mismatch' | 'unreadable';

/** What the boot found when it read the marker table. */
export type MarkerRead =
  | { readonly kind: 'rows'; readonly markers: readonly string[] }
  | { readonly kind: 'no_table' }
  | { readonly kind: 'failed' };

export type DatabaseIdentity =
  | { readonly status: 'VERIFIED'; readonly marker: string }
  | {
      readonly status: 'UNKNOWN';
      readonly reason: IdentityUnknownReason;
      /** The stored marker, when exactly one row exists. */
      readonly marker?: string;
    };

/** Postgres SQLSTATE `undefined_table`. */
const UNDEFINED_TABLE = '42P01';

/**
 * VERIFIED only when `expected` is configured and equals the single stored
 * marker exactly: no trimming, no case folding. Every other outcome is UNKNOWN.
 */
export function decideIdentity(
  expected: string | undefined,
  read: MarkerRead,
): DatabaseIdentity {
  const stored =
    read.kind === 'rows' && read.markers.length === 1
      ? read.markers[0]
      : undefined;
  const unknown = (reason: IdentityUnknownReason): DatabaseIdentity =>
    stored === undefined
      ? { status: 'UNKNOWN', reason }
      : { status: 'UNKNOWN', reason, marker: stored };

  if (expected === undefined || expected.trim() === '') {
    return unknown('not_configured');
  }
  if (read.kind === 'failed') return unknown('unreadable');
  if (read.kind === 'no_table' || read.markers.length === 0) {
    return unknown('missing_marker');
  }
  // More than one row breaks the table's own constraint: not a marker to trust.
  if (stored === undefined) return unknown('unreadable');
  if (stored !== expected) return unknown('mismatch');
  return { status: 'VERIFIED', marker: stored };
}

/** Every UNKNOWN blocks entries. Only VERIFIED does not. Exits never ask. */
export function blocksEntries(identity: DatabaseIdentity): boolean {
  return identity.status !== 'VERIFIED';
}

/**
 * A failed marker query, classified. A missing table is `no_table`; anything
 * else, including a value that is not an error, is `failed`.
 */
export function markerReadFailure(error: unknown): MarkerRead {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return code === UNDEFINED_TABLE ? { kind: 'no_table' } : { kind: 'failed' };
}

/** The fields of the boot's identity log line. */
export function identityLogFields(
  identity: DatabaseIdentity,
): Record<string, string> {
  const fields: Record<string, string> = { status: identity.status };
  if (identity.status === 'UNKNOWN') fields.reason = identity.reason;
  if (identity.marker !== undefined) fields.marker = identity.marker;
  return fields;
}
