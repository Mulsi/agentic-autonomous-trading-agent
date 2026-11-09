import { stdTimeFunctions, type LoggerOptions } from 'pino';
import { currentCorrelationId } from '../shared/correlation.js';
import { REDACTED, scrubSecrets } from './secrets.js';

// Two layers keep secrets out of the logs.
//
// 1. Key paths. These censor a value by its key, top level or one level down,
//    such as `{ settings }`. `DATABASE_URL` embeds a password. Settings no
//    longer load `ANTHROPIC_API_KEY` (D9), but the parent environment may still
//    hold one (§9), so the name stays in case an env-shaped object is logged.
// 2. Values. `hooks.streamWrite` scrubs each serialized line for the loaded
//    secret values (see `secretValues`), so a secret nested at any depth, under
//    any key name, interpolated into a message, or inside an error is caught.
const SECRET_PATHS = [
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  '*.ANTHROPIC_API_KEY',
  '*.DATABASE_URL',
];

/** Pino options that redact the key paths and scrub `secrets` by value. */
export function loggerOptions(secrets: readonly string[]): LoggerOptions {
  const values = [...secrets];

  return {
    base: null,
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: SECRET_PATHS, censor: REDACTED },
    hooks: { streamWrite: (line) => scrubSecrets(line, values) },
    mixin() {
      const correlationId = currentCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
  };
}
