import { z } from 'zod';
import { Decimal } from '../shared/decimal.js';
import {
  checkInterval,
  checkPeriod,
  checkSymbol,
  periodRange,
  type BulkPeriod,
} from './binance-vision.js';
import type { KlineInterval } from './normalizer.js';

// The backfill command line (S1b). Every flag is required except --dry-run,
// and none has a default: the outlier window and multiple have no production
// value yet (master Part II §13), so each run states them and its summaries
// mark them provisional.

export interface BackfillArgs {
  readonly symbol: string;
  readonly interval: KlineInterval;
  readonly period: BulkPeriod;
  readonly from: string;
  readonly to: string;
  readonly outlierWindow: number;
  readonly outlierMultiple: number;
  readonly dryRun: boolean;
}

export type ArgsResult =
  | { readonly ok: true; readonly args: BackfillArgs }
  | { readonly ok: false; readonly message: string };

export const USAGE = [
  'usage: backfill --symbol <SYMBOL> --interval <15m|1h|4h|1d>',
  '                --period <daily|monthly> --from <date> --to <date>',
  '                --outlier-window <integer >= 1>',
  '                --outlier-multiple <decimal >= 1> [--dry-run]',
  'Dates are YYYY-MM-DD for daily and YYYY-MM for monthly, inclusive, UTC.',
].join('\n');

const VALUE_FLAGS = [
  '--symbol',
  '--interval',
  '--period',
  '--from',
  '--to',
  '--outlier-window',
  '--outlier-multiple',
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const DRY_RUN = '--dry-run';

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** A zod check that runs `check` and reports its message on failure. */
function checked<T>(check: (value: string) => T) {
  return z.string().transform((value, context): T => {
    try {
      return check(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'is invalid',
      });
      return z.NEVER;
    }
  });
}

const schema = z.strictObject({
  '--symbol': checked(checkSymbol),
  '--interval': checked(checkInterval),
  '--period': checked(checkPeriod),
  '--from': z.string(),
  '--to': z.string(),
  '--outlier-window': z
    .string()
    .regex(POSITIVE_INTEGER, 'must be an integer >= 1')
    .transform(Number)
    .refine(Number.isSafeInteger, 'must be a safe integer'),
  '--outlier-multiple': z
    .string()
    .regex(PLAIN_DECIMAL, 'must be a plain decimal number >= 1')
    .refine(
      // zod runs a refinement after a failed regex too, so it checks again.
      (value) => PLAIN_DECIMAL.test(value) && new Decimal(value).gte(1),
      'must be at least 1',
    )
    .transform(Number)
    .refine(Number.isFinite, 'must be finite'),
});

const fail = (message: string): ArgsResult => ({
  ok: false,
  message: `${message}\n${USAGE}`,
});

/**
 * Parses `--flag value` pairs. A missing, unknown, repeated or invalid flag is
 * a usage error naming the flag.
 */
export function parseBackfillArgs(argv: readonly string[]): ArgsResult {
  const values: Partial<Record<ValueFlag, string>> = {};
  let dryRun = false;
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] as string;
    if (token === DRY_RUN) {
      if (dryRun) return fail(`${DRY_RUN} is repeated`);
      dryRun = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(token)) {
      return fail(`unknown argument: ${JSON.stringify(token)}`);
    }
    const flag = token as ValueFlag;
    if (values[flag] !== undefined) return fail(`${flag} is repeated`);
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) {
      return fail(`${flag} needs a value`);
    }
    values[flag] = value;
    at += 1;
  }

  const missing = VALUE_FLAGS.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) return fail(`missing ${missing.join(', ')}`);

  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return fail(
      issue === undefined
        ? 'invalid arguments'
        : `${String(issue.path[0])} ${issue.message}`,
    );
  }
  const data = parsed.data;

  for (const flag of ['--from', '--to'] as const) {
    try {
      periodRange(data['--period'], data[flag], flag);
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : `${flag} is invalid`,
      );
    }
  }
  if (
    periodRange(data['--period'], data['--from']).fromMs >
    periodRange(data['--period'], data['--to']).fromMs
  ) {
    return fail('--from must not be after --to');
  }

  return {
    ok: true,
    args: {
      symbol: data['--symbol'],
      interval: data['--interval'],
      period: data['--period'],
      from: data['--from'],
      to: data['--to'],
      outlierWindow: data['--outlier-window'],
      outlierMultiple: data['--outlier-multiple'],
      dryRun,
    },
  };
}
