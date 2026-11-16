import { Decimal as DecimalJs } from 'decimal.js';

/**
 * The money type (D2). A clone of decimal.js with its default settings, so no
 * module here changes decimal.js's global configuration and no other module's
 * change reaches this one. Parsing a string is exact at any length; arithmetic
 * rounds to the clone's precision (20 significant digits).
 */
export const Decimal: typeof DecimalJs = DecimalJs.clone({ defaults: true });
export type Decimal = DecimalJs;

/** No sign, no exponent, no whitespace, no leading zero but a single `0`. */
const NON_NEGATIVE_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Reads a non-negative decimal string exactly. Anything else, a JS `number`
 * included, gives `undefined`: a number has already lost its digits.
 */
export function parseNonNegativeDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' || !NON_NEGATIVE_DECIMAL.test(value)) {
    return undefined;
  }
  return new Decimal(value);
}
