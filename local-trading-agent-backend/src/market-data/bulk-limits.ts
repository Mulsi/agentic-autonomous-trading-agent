// Input-safety bounds for the bulk loader (S1b). Each is sized well above the
// largest expected file: a monthly 15m kline file holds at most 2,976 rows of
// about 150 bytes, about 450 KB of CSV and less as a zip. They bound what an
// untrusted download can make the process hold. They are not trading or risk
// limits, so master Part II §13 does not apply to them.

/** A CHECKSUM file is one line of about 100 bytes. 1 KiB. */
export const MAX_CHECKSUM_BYTES = 1024;

/** The largest zip the loader downloads and holds in memory. 8 MiB. */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/**
 * The largest CSV the loader inflates from one archive, declared or actual.
 * 16 MiB: a zip bomb stops here.
 */
export const MAX_CSV_BYTES = 16 * 1024 * 1024;

/** The longest CSV line, in bytes. A kline line is about 150. */
export const MAX_LINE_BYTES = 1024;

/** One GET gives up after this long, body included. 60 seconds. */
export const REQUEST_TIMEOUT_MS = 60_000;
