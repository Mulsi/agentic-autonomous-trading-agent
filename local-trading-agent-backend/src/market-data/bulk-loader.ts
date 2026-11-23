import { hash } from 'node:crypto';
import {
  filesFor,
  parseChecksum,
  type BulkFile,
  type BulkPeriod,
} from './binance-vision.js';
import {
  splitBulkCsv,
  timeUnits,
  type CsvLine,
  type TimeUnits,
} from './bulk-csv.js';
import {
  MAX_ARCHIVE_BYTES,
  MAX_CHECKSUM_BYTES,
  MAX_CSV_BYTES,
  REQUEST_TIMEOUT_MS,
} from './bulk-limits.js';
import {
  intervalMs,
  normalizeEpoch,
  type Candle,
  type KlineInterval,
} from './normalizer.js';
import {
  STORED_QUARANTINE_REASONS,
  type StoredQuarantineReason,
} from './quarantine-reasons.js';
import {
  validateKlines,
  type KlineBatch,
  type MissingRange,
  type OutlierOptions,
} from './validator.js';
import type { HttpGet } from './vision-http.js';
import { readSingleEntry } from './zip-entry.js';

// The bulk history loader (S1b): download, verify, then parse, validate and
// store, one file at a time. No Nest and no database here: storage goes
// through `CandleSink`, the network through `HttpGet`, and the clock is the
// caller's `asOfMs`. Rows go through `validateKlines` unchanged (D13).
//
// Nothing from a row's content reaches a summary: summaries hold counts,
// reasons, times and file names only (Rule 11).

/** The `source` of every stored candle and quarantine row. */
export const BULK_SOURCE = 'binance_vision';

export interface LoadRequest {
  readonly symbol: string;
  readonly interval: KlineInterval;
  readonly period: BulkPeriod;
  /** Inclusive, in the period's date format. */
  readonly from: string;
  readonly to: string;
  /** The caller's clock, read once. */
  readonly asOfMs: number;
  /** Required, with no default; the multiple must be at least 1. */
  readonly outlier: OutlierOptions;
  readonly dryRun: boolean;
}

/** One accepted candle as it is stored. */
export interface StoredCandle {
  readonly candle: Candle;
  /** False for a bar the outlier rule could not judge (`unjudged`). */
  readonly outlierChecked: boolean;
  /** The CSV line the candle came from. */
  readonly line: CsvLine;
}

/** One quarantine row as it is stored. `raw` is the line's original text. */
export interface StoredQuarantine {
  readonly source: string;
  readonly sourceFile: string;
  readonly rowIndex: number;
  readonly symbol: string;
  readonly timeframe: KlineInterval;
  readonly reason: StoredQuarantineReason;
  readonly openTimeMs: number | null;
  readonly raw: string;
}

export interface WriteResult {
  readonly inserted: number;
  readonly alreadyStored: number;
  readonly storedConflicts: number;
}

/** Stores one file's result in one transaction, or throws and stores nothing. */
export interface CandleSink {
  storeFile(
    file: BulkFile,
    batch: KlineBatch,
    lines: readonly CsvLine[],
  ): Promise<WriteResult>;
}

export interface LoadDeps {
  readonly http: HttpGet;
  /** `null` only for a dry run. */
  readonly sink: CandleSink | null;
  /** Called with each file's summary as soon as it is done. */
  readonly report?: (summary: FileSummary) => void;
}

export type FileStatus =
  | 'loaded'
  | 'not_found'
  | 'checksum_unavailable'
  | 'http_error'
  | 'checksum_mismatch'
  | 'archive_rejected'
  | 'store_error';

export type ChecksumStatus =
  | 'verified'
  | 'not_found'
  | 'unavailable'
  | 'mismatch'
  /** The CHECKSUM parsed, but the zip never arrived to compare. */
  | 'not_compared';

/** A plain object with no raw content: counts, reasons, times, names. */
export interface FileSummary {
  readonly file: string;
  readonly status: FileStatus;
  /** A short machine reason for a failure (`timeout`, `crc_mismatch`, ...). */
  readonly detail: string | null;
  readonly checksum: ChecksumStatus;
  readonly sha256: string | null;
  readonly header: boolean | null;
  readonly rows: number;
  readonly accepted: number;
  readonly open: number;
  readonly quarantined: Partial<Record<StoredQuarantineReason, number>>;
  readonly missing: readonly MissingRange[];
  readonly unjudged: number;
  readonly duplicatesCollapsed: number;
  readonly outOfOrder: number;
  readonly timeUnits: TimeUnits | null;
  readonly firstOpenTimeMs: number | null;
  readonly lastOpenTimeMs: number | null;
  readonly lastCloseTimeMs: number | null;
  readonly written: boolean;
  readonly inserted: number;
  readonly alreadyStored: number;
  readonly storedConflicts: number;
  readonly outlier: {
    readonly window: number;
    readonly maxRangeMultiple: number;
    readonly provisional: true;
  };
}

function checkOutlier({ window, maxRangeMultiple }: OutlierOptions): void {
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new RangeError('outlier.window must be an integer >= 1');
  }
  if (!Number.isFinite(maxRangeMultiple) || maxRangeMultiple < 1) {
    throw new RangeError('outlier.maxRangeMultiple must be finite and >= 1');
  }
}

/**
 * The files a request covers, ascending. Throws a RangeError for a bad
 * argument, and for any period that has not fully closed at `asOfMs`, so the
 * loader never asks for one.
 */
export function planFiles(request: LoadRequest): BulkFile[] {
  if (!Number.isSafeInteger(request.asOfMs)) {
    throw new RangeError('asOfMs must be a safe integer');
  }
  checkOutlier(request.outlier);
  const files = filesFor(
    request.symbol,
    request.interval,
    request.period,
    request.from,
    request.to,
  );
  const open = files.find((file) => file.range.toMs > request.asOfMs);
  if (open !== undefined) {
    throw new RangeError(
      `to names a period that has not closed: ${open.zipName}`,
    );
  }
  return files;
}

/**
 * Maps the batch back to the CSV lines. Each quarantine record is found by the
 * identity of its `raw`, the `fields` array the loader passed in, so two
 * identical lines are never confused. Each accepted candle is the first line
 * of its slot that was not quarantined: the copy the validator kept.
 */
export function storedRows(
  file: BulkFile,
  batch: KlineBatch,
  lines: readonly CsvLine[],
): { candles: StoredCandle[]; quarantine: StoredQuarantine[] } {
  const byFields = new Map<unknown, CsvLine>(
    lines.map((line) => [line.fields, line]),
  );
  const quarantinedLines = new Set<CsvLine>();
  const quarantine = batch.quarantined.map((record): StoredQuarantine => {
    const line = byFields.get(record.raw);
    if (line === undefined) {
      throw new Error('A quarantine record does not map to a CSV line');
    }
    quarantinedLines.add(line);
    return quarantineRow(file, line, record.reason, record.openTimeMs ?? null);
  });

  const firstLine = new Map<number, CsvLine>();
  for (const line of lines) {
    if (quarantinedLines.has(line)) continue;
    const epoch = normalizeEpoch(line.fields[0]);
    if (epoch.ok && !firstLine.has(epoch.ms)) firstLine.set(epoch.ms, line);
  }
  const unjudged = new Set(batch.unjudged);
  const candles = batch.candles.map((candle): StoredCandle => {
    const line = firstLine.get(candle.openTimeMs);
    if (line === undefined) {
      throw new Error('An accepted candle does not map to a CSV line');
    }
    return {
      candle,
      outlierChecked: !unjudged.has(candle.openTimeMs),
      line,
    };
  });
  return { candles, quarantine };
}

/** A quarantine row for `line`. */
export function quarantineRow(
  file: BulkFile,
  line: CsvLine,
  reason: StoredQuarantineReason,
  openTimeMs: number | null,
): StoredQuarantine {
  return {
    source: BULK_SOURCE,
    sourceFile: file.zipName,
    rowIndex: line.index,
    symbol: file.symbol,
    timeframe: file.interval,
    reason,
    openTimeMs,
    raw: line.text,
  };
}

function countReasons(
  batch: KlineBatch,
): Partial<Record<StoredQuarantineReason, number>> {
  const counts: Partial<Record<StoredQuarantineReason, number>> = {};
  for (const reason of STORED_QUARANTINE_REASONS) {
    const count = batch.quarantined.filter(
      (record) => record.reason === reason,
    ).length;
    if (count > 0) counts[reason] = count;
  }
  return counts;
}

function emptySummary(
  file: BulkFile,
  request: LoadRequest,
): Omit<FileSummary, 'status' | 'checksum' | 'detail'> {
  return {
    file: file.zipName,
    sha256: null,
    header: null,
    rows: 0,
    accepted: 0,
    open: 0,
    quarantined: {},
    missing: [],
    unjudged: 0,
    duplicatesCollapsed: 0,
    outOfOrder: 0,
    timeUnits: null,
    firstOpenTimeMs: null,
    lastOpenTimeMs: null,
    lastCloseTimeMs: null,
    written: false,
    inserted: 0,
    alreadyStored: 0,
    storedConflicts: 0,
    outlier: {
      window: request.outlier.window,
      maxRangeMultiple: request.outlier.maxRangeMultiple,
      provisional: true,
    },
  };
}

/** `sqlstate_<code>` when the error carries a SQLSTATE, else null. */
function storeErrorDetail(error: unknown): string | null {
  let code: unknown;
  try {
    code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
  } catch {
    return null;
  }
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `sqlstate_${code}`
    : null;
}

const decoder = (): TextDecoder => new TextDecoder('utf-8', { fatal: true });

interface FileOutcome {
  readonly summary: FileSummary;
  /** Set when the file reached validation. */
  readonly checked?: readonly Candle[];
}

async function loadFile(
  file: BulkFile,
  request: LoadRequest,
  deps: LoadDeps,
  history: readonly Candle[],
): Promise<FileOutcome> {
  const base = emptySummary(file, request);
  const failed = (
    status: FileStatus,
    checksum: ChecksumStatus,
    detail: string | null,
    extra: Partial<FileSummary> = {},
  ): FileOutcome => ({
    summary: { ...base, ...extra, status, checksum, detail },
  });

  // 1. The CHECKSUM. Without one, the zip is never requested.
  const checksumResponse = await deps.http.get(file.checksumUrl, {
    maxBytes: MAX_CHECKSUM_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!checksumResponse.ok) {
    return failed(
      'checksum_unavailable',
      'unavailable',
      checksumResponse.reason,
    );
  }
  if (checksumResponse.status === 404) {
    return failed('not_found', 'not_found', 'checksum_404');
  }
  if (checksumResponse.status !== 200) {
    return failed(
      'checksum_unavailable',
      'unavailable',
      `status_${checksumResponse.status}`,
    );
  }
  let checksumText: string;
  try {
    checksumText = decoder().decode(checksumResponse.body);
  } catch {
    return failed('checksum_unavailable', 'unavailable', 'bad_encoding');
  }
  const checksum = parseChecksum(checksumText, file.zipName);
  if (!checksum.ok) {
    return failed('checksum_unavailable', 'unavailable', checksum.reason);
  }

  // 2. The zip, held in memory only.
  const zipResponse = await deps.http.get(file.zipUrl, {
    maxBytes: MAX_ARCHIVE_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!zipResponse.ok) {
    return failed('http_error', 'not_compared', zipResponse.reason);
  }
  if (zipResponse.status === 404) {
    return failed('not_found', 'not_compared', 'zip_404');
  }
  if (zipResponse.status !== 200) {
    return failed('http_error', 'not_compared', `status_${zipResponse.status}`);
  }

  // 3. Verify before a single byte is parsed.
  const sha256 = hash('sha256', zipResponse.body, 'hex');
  if (sha256 !== checksum.sha256) {
    return failed('checksum_mismatch', 'mismatch', null, { sha256 });
  }

  // 4. Open the archive, then split the CSV.
  const entry = readSingleEntry(zipResponse.body, file.csvName, MAX_CSV_BYTES);
  if (!entry.ok) {
    return failed('archive_rejected', 'verified', entry.reason, { sha256 });
  }
  const stepMs = intervalMs(file.interval);
  const expectedSlots = (file.range.toMs - file.range.fromMs) / stepMs;
  const csv = splitBulkCsv(entry.bytes, expectedSlots);
  if (!csv.ok) {
    return failed('archive_rejected', 'verified', csv.reason, { sha256 });
  }

  // 5. Validate, unchanged from S1a.
  const batch = validateKlines(
    csv.lines.map((line) => line.fields),
    {
      symbol: file.symbol,
      interval: file.interval,
      range: file.range,
      asOfMs: request.asOfMs,
      outlier: request.outlier,
      history,
    },
  );
  const first = batch.candles[0];
  const last = batch.candles.at(-1);
  const validated: Omit<FileSummary, 'status' | 'checksum' | 'detail'> = {
    ...base,
    sha256,
    header: csv.header,
    rows: csv.lines.length,
    accepted: batch.candles.length,
    open: batch.open.length,
    quarantined: countReasons(batch),
    missing: batch.missing,
    unjudged: batch.unjudged.length,
    duplicatesCollapsed: batch.duplicatesCollapsed,
    outOfOrder: batch.outOfOrder,
    timeUnits: timeUnits(csv.lines),
    firstOpenTimeMs: first?.openTimeMs ?? null,
    lastOpenTimeMs: last?.openTimeMs ?? null,
    lastCloseTimeMs: last?.closeTimeMs ?? null,
  };

  // 6. Store, unless this is a dry run.
  if (request.dryRun) {
    return {
      summary: {
        ...validated,
        status: 'loaded',
        checksum: 'verified',
        detail: null,
      },
      checked: batch.checked,
    };
  }
  const sink = deps.sink as CandleSink;
  let written: WriteResult;
  try {
    written = await sink.storeFile(file, batch, csv.lines);
  } catch (error) {
    // The sink rolled the whole file back. The error's message may quote row
    // content, so only a well-formed SQLSTATE leaves this function (Rule 11).
    return {
      summary: {
        ...validated,
        status: 'store_error',
        checksum: 'verified',
        detail: storeErrorDetail(error),
      },
      checked: batch.checked,
    };
  }
  return {
    summary: {
      ...validated,
      status: 'loaded',
      checksum: 'verified',
      detail: null,
      written: true,
      inserted: written.inserted,
      alreadyStored: written.alreadyStored,
      storedConflicts: written.storedConflicts,
    },
    checked: batch.checked,
  };
}

/**
 * Loads every file of the request, one at a time, in ascending order, with no
 * concurrency and no retry. A failed file never stops later ones. Each file's
 * `history` is the `checked` output of the files before it that reached
 * validation: at least the whole of the last one, and enough earlier bars that
 * the outlier rule sees `window + 1` of them, so a chained run judges every
 * bar exactly as one batch over the whole range would (D13).
 */
export async function loadKlines(
  request: LoadRequest,
  deps: LoadDeps,
): Promise<FileSummary[]> {
  const files = planFiles(request);
  if (!request.dryRun && deps.sink === null) {
    throw new RangeError('sink is required unless dryRun is set');
  }
  const summaries: FileSummary[] = [];
  let history: readonly Candle[] = [];
  for (const file of files) {
    const outcome = await loadFile(file, request, deps, history);
    if (outcome.checked !== undefined) {
      const keep = Math.max(request.outlier.window + 1, outcome.checked.length);
      history = [...history, ...outcome.checked].slice(-keep);
    }
    summaries.push(outcome.summary);
    deps.report?.(outcome.summary);
  }
  return summaries;
}
