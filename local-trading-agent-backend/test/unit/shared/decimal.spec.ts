import { Decimal as GlobalDecimal } from 'decimal.js';
import fc from 'fast-check';
import {
  Decimal,
  parseNonNegativeDecimal,
} from '../../../src/shared/decimal.js';

describe('parseNonNegativeDecimal (criterion 1)', () => {
  it.each(['0', '0.00000000', '60000.01000000', '1.000000000000000001'])(
    'reads %s exactly',
    (text) => {
      const value = parseNonNegativeDecimal(text);

      expect(value).toBeInstanceOf(Decimal);
      expect(value?.eq(new Decimal(text))).toBe(true);
    },
  );

  it('keeps every digit of 1.000000000000000001', () => {
    expect(parseNonNegativeDecimal('1.000000000000000001')?.toFixed()).toBe(
      '1.000000000000000001',
    );
    expect(parseNonNegativeDecimal('1.000000000000000001')?.eq(1)).toBe(false);
  });

  it.each([
    '-1',
    '+1',
    '1e5',
    ' 1',
    '1 ',
    '01',
    '1.',
    '.5',
    '',
    'NaN',
    'Infinity',
  ])('rejects the string %j', (text) => {
    expect(parseNonNegativeDecimal(text)).toBeUndefined();
  });

  it.each([
    ['the number 1', 1],
    ['the number 60000.01', 60000.01],
    ['null', null],
    ['undefined', undefined],
    ['an object', { value: '1' }],
  ])('rejects %s', (_, value) => {
    expect(parseNonNegativeDecimal(value)).toBeUndefined();
  });
});

describe('the Decimal clone', () => {
  it('is not the global decimal.js constructor, so it shares no configuration', () => {
    expect(Decimal).not.toBe(GlobalDecimal);
  });
});

describe('no precision is lost (criterion 2)', () => {
  const digit = fc.constantFrom(...'0123456789'.split(''));
  const nonZeroDigit = fc.constantFrom(...'123456789'.split(''));
  const digits = (min: number, max: number) =>
    fc.array(digit, { minLength: min, maxLength: max }).map((d) => d.join(''));

  /** Integer part, fractional part, and the string the generator builds. */
  const decimalString = fc
    .record({
      integer: fc.oneof(
        fc.constant('0'),
        fc
          .tuple(nonZeroDigit, digits(0, 14))
          .map(([first, rest]) => first + rest),
      ),
      fraction: fc.option(digits(1, 15), { nil: undefined }),
    })
    .map(({ integer, fraction }) => ({
      integer,
      fraction,
      text: fraction === undefined ? integer : `${integer}.${fraction}`,
    }));

  it('toFixed() gives the canonical form of every generated string', () => {
    fc.assert(
      fc.property(decimalString, ({ integer, fraction, text }) => {
        const trimmed = (fraction ?? '').replace(/0+$/, '');
        const canonical = trimmed === '' ? integer : `${integer}.${trimmed}`;

        expect(parseNonNegativeDecimal(text)?.toFixed()).toBe(canonical);
      }),
      { numRuns: 1000 },
    );
  });
});
