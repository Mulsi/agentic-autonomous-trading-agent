import { stdTimeFunctions, type LoggerOptions } from 'pino';
import { currentCorrelationId } from '../shared/correlation.js';

// `DATABASE_URL` embeds a password, so it counts as a secret here. The wildcard
// covers one level of nesting, such as `{ settings }`. Do not log these deeper.
const SECRET_PATHS = [
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  '*.ANTHROPIC_API_KEY',
  '*.DATABASE_URL',
];

export const pinoOptions: LoggerOptions = {
  base: null,
  timestamp: stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: SECRET_PATHS, censor: '[REDACTED]' },
  mixin() {
    const correlationId = currentCorrelationId();
    return correlationId === undefined ? {} : { correlationId };
  },
};
