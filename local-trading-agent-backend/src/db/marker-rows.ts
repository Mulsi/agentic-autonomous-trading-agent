import { z } from 'zod';
import type { MarkerRead } from './identity.js';

// The rows of the marker query, checked where they enter the app (D2). The
// database may be a stand-in, so its rows are external data (Rule 11): a
// `marker` that is not a string is never coerced, and never reaches the log
// line. Pure: no Nest, no driver. src/db/identity.ts stays import-free.

const markerRows = z.array(z.object({ marker: z.string() }));

/**
 * `{ kind: 'rows' }` with the markers in order and unchanged, when `rows` is an
 * array of objects that each hold a string `marker`. Anything else is a failed
 * read with no `sqlstate`, which the identity check reads as UNKNOWN
 * `unreadable`. Never throws.
 */
export function markerReadFromRows(rows: unknown): MarkerRead {
  try {
    const parsed = markerRows.safeParse(rows);
    return parsed.success
      ? { kind: 'rows', markers: parsed.data.map((row) => row.marker) }
      : { kind: 'failed' };
  } catch {
    // safeParse does not throw on data; a hostile getter or proxy still could.
    return { kind: 'failed' };
  }
}
