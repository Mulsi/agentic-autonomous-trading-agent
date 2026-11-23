import { ROW_REJECT_REASONS } from './normalizer.js';
import type { QuarantineReason } from './validator.js';

/**
 * Every reason a stored quarantine row can carry: the validator's reasons,
 * plus `stored_conflict` for a row that differs from the candle already
 * stored for its slot. The `market_data_quarantine.reason` check in the
 * migration lists exactly these (a unit test compares them).
 */
export const STORED_QUARANTINE_REASONS = [
  ...ROW_REJECT_REASONS,
  'future_bar',
  'outside_range',
  'duplicate_conflict',
  'outlier',
  'stored_conflict',
] as const;

export type StoredQuarantineReason = (typeof STORED_QUARANTINE_REASONS)[number];

// Both directions, checked by the compiler: the list holds every validator
// reason and nothing that is neither one of them nor `stored_conflict`.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const covers: Exact<
  StoredQuarantineReason,
  QuarantineReason | 'stored_conflict'
> = true;
void covers;
