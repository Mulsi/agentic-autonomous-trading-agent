import { inspect } from 'node:util';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { scrubSecrets } from './secrets.js';

// Two paths print outside pino when a boot fails, and both can carry a database
// error: Nest's default logger before `useLogger` (the ExceptionHandler line and
// the flushed boot lines), and the printer for the rejected bootstrap in
// main.ts. Both scrub the secret values that ConfigModule recorded when it
// parsed the settings, so nothing reads the environment a second time.

let recorded: readonly string[] = [];

/** Called once per boot by ConfigModule, with `secretValues(settings)`. */
export function recordBootSecrets(values: readonly string[]): void {
  recorded = [...values];
}

/** The values recorded at boot; empty before the settings parsed. */
export function bootSecrets(): readonly string[] {
  return recorded;
}

/**
 * Nest's default logger with every printed message and stack scrubbed. Passed
 * as `logger` to `createApplicationContext`, so it prints whatever Nest writes
 * before `useLogger` hands output to pino. Plain text, no colours.
 */
export class BootConsoleLogger extends ConsoleLogger {
  constructor() {
    super({ colors: false });
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    return scrubSecrets(
      super.formatMessage(
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
        params,
      ),
      bootSecrets(),
    );
  }

  protected override printStackTrace(stack: string | undefined): void {
    // Nest calls this with no stack for most lines; it then prints nothing.
    super.printStackTrace(
      typeof stack === 'string' ? scrubSecrets(stack, bootSecrets()) : '',
    );
  }
}

/**
 * Prints a failed boot to stderr, scrubbed, and makes the process exit 1
 * (D11: loud, never swallowed). Replaces Node's printer for an unhandled
 * rejection, which does not scrub.
 */
export function printBootFailure(error: unknown): void {
  process.exitCode = 1;
  const text = inspect(error, { depth: 4 });
  process.stderr.write(`${scrubSecrets(text, bootSecrets())}\n`);
}
