import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { BackfillModule } from './backfill.module.js';
import { BootConsoleLogger, printBootFailure } from './config/boot-output.js';
import { IDENTITY } from './db/db.module.js';
import { identityLogFields, type DatabaseIdentity } from './db/identity.js';
import { parseBackfillArgs } from './market-data/backfill-args.js';
import {
  loadKlines,
  planFiles,
  type CandleSink,
  type FileSummary,
  type LoadRequest,
} from './market-data/bulk-loader.js';
import { CANDLE_SINK, HTTP_GET } from './market-data/market-data.module.js';
import { visionHttpGet, type HttpGet } from './market-data/vision-http.js';
import { runWithCorrelation } from './shared/correlation.js';

// The backfill command (S1b), separate from `trader run`. A dry run builds no
// Nest context, reads no settings and opens no database connection: it prints
// one JSON summary line per file to stdout and nothing else. A write run boots
// BackfillModule and writes only when the database identity is VERIFIED.
//
// Exit codes: 0 when every file loaded, 1 when any file failed or the write
// was refused, 2 on a usage error. Summaries and log lines carry counts,
// reasons, times and file names only, never a raw line (Rule 11).

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The structured log calls the write run makes. */
export interface BackfillLogger {
  log(message: object, context: string): void;
  warn(message: object, context: string): void;
  error(message: object, context: string): void;
}

/** What a write run needs from its booted context. */
export interface BackfillContext {
  readonly identity: DatabaseIdentity;
  readonly http: HttpGet;
  readonly sink: CandleSink;
  readonly logger: BackfillLogger;
  close(): Promise<void>;
}

export interface BackfillDeps {
  /** The clock, read once per run. */
  readonly clock: () => number;
  /** The dry run's HTTP. Never constructed on a usage error. */
  readonly dryRunHttp: () => HttpGet;
  /** Boots the write run's context. Never called for a dry run. */
  readonly openContext: () => Promise<BackfillContext>;
  /** Prints a failed boot, scrubbed (D11). */
  readonly bootFailed: (error: unknown) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The error's class name only: a message could quote anything. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function exitCode(summaries: readonly FileSummary[]): number {
  return summaries.every((summary) => summary.status === 'loaded')
    ? EXIT_OK
    : EXIT_FAILED;
}

/** Runs the command for `argv` (without node and the script) and returns the exit code. */
export async function run(
  argv: readonly string[],
  deps: BackfillDeps,
): Promise<number> {
  const parsed = parseBackfillArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.message}\n`);
    return EXIT_USAGE;
  }
  const { args } = parsed;
  const request: LoadRequest = {
    symbol: args.symbol,
    interval: args.interval,
    period: args.period,
    from: args.from,
    to: args.to,
    asOfMs: deps.clock(),
    outlier: {
      window: args.outlierWindow,
      maxRangeMultiple: args.outlierMultiple,
    },
    dryRun: args.dryRun,
  };
  try {
    planFiles(request);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    deps.stderr(`${error.message}\n`);
    return EXIT_USAGE;
  }

  if (args.dryRun) {
    try {
      const summaries = await loadKlines(request, {
        http: deps.dryRunHttp(),
        sink: null,
        report: (summary) => deps.stdout(`${JSON.stringify(summary)}\n`),
      });
      return exitCode(summaries);
    } catch (error) {
      deps.stderr(`Backfill failed: ${errorName(error)}\n`);
      return EXIT_FAILED;
    }
  }

  let context: BackfillContext;
  try {
    context = await deps.openContext();
  } catch (error) {
    deps.bootFailed(error);
    return EXIT_FAILED;
  }
  try {
    const { identity, logger } = context;
    const line = { msg: 'Database identity', ...identityLogFields(identity) };
    if (identity.status !== 'VERIFIED') {
      // Rule 9: never write to a database that may be a stand-in.
      logger.warn(line, 'Database');
      logger.error(
        { msg: 'Backfill refused: database identity is not VERIFIED' },
        'Backfill',
      );
      return EXIT_FAILED;
    }
    logger.log(line, 'Database');
    try {
      const summaries = await loadKlines(request, {
        http: context.http,
        sink: context.sink,
        report: (summary) => {
          const line = { msg: 'Backfill file', ...summary };
          if (summary.status === 'loaded') logger.log(line, 'Backfill');
          else logger.warn(line, 'Backfill');
        },
      });
      return exitCode(summaries);
    } catch (error) {
      logger.error(
        { msg: 'Backfill failed', error: errorName(error) },
        'Backfill',
      );
      return EXIT_FAILED;
    }
  } finally {
    await context.close();
  }
}

/** The write run's context from a booted BackfillModule. */
export function backfillContext(app: INestApplicationContext): BackfillContext {
  const logger = app.get(Logger);
  app.useLogger(logger);
  return {
    identity: app.get<DatabaseIdentity>(IDENTITY),
    http: app.get<HttpGet>(HTTP_GET),
    sink: app.get<CandleSink>(CANDLE_SINK),
    logger,
    close: () => app.close(),
  };
}

export const productionDeps: BackfillDeps = {
  clock: Date.now,
  dryRunHttp: () => visionHttpGet(),
  openContext: async () =>
    backfillContext(
      await NestFactory.createApplicationContext(BackfillModule, {
        // Rethrow, so a failed boot reaches printBootFailure (D11).
        abortOnError: false,
        bufferLogs: true,
        // Prints Nest's own lines, scrubbed, until useLogger hands them to pino.
        logger: new BootConsoleLogger(),
      }),
    ),
  bootFailed: printBootFailure,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

if (import.meta.main) {
  process.exitCode = await runWithCorrelation(() =>
    run(process.argv.slice(2), productionDeps),
  );
}
