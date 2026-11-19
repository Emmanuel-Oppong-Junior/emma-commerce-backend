import { Decimal } from '@prisma/client/runtime/client';
import { Money, roundHalfUp, toMinorUnits } from './money';

const ghs = (value: Decimal.Value) => Money.of(value, 'GHS');

/** Deterministic pseudo-random integers, so the property loops are reproducible. */
function sequence(seed: number) {
  let state = seed;
  return (maxExclusive: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % maxExclusive;
  };
}

describe('Money', () => {
  describe('construction', () => {
    it('keeps the exact decimal value it is given', () => {
      expect(ghs('0.1').add(ghs('0.2')).amount.toString()).toBe('0.3');
      expect(ghs(new Decimal('19.999')).amount.toString()).toBe('19.999');
    });

    it.each([NaN, Infinity, -Infinity, 'NaN', 'Infinity'])('rejects the non-finite amount %p', (value) => {
      expect(() => ghs(value)).toThrow(RangeError);
    });

    it('rejects text that is not a number', () => {
      expect(() => ghs('twelve')).toThrow();
    });

    it('has a zero in any currency', () => {
      expect(Money.zero('USD')).toMatchObject({ currency: 'USD' });
      expect(Money.zero('GHS').isZero()).toBe(true);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly, where floats would not', () => {
      expect(ghs('0.1').add(ghs('0.2')).equals(ghs('0.3'))).toBe(true);
      expect(ghs('1.00').subtract(ghs('0.90')).toString()).toBe('0.10');
      expect(ghs('10').subtract(ghs('10.01')).isNegative()).toBe(true);
    });

    it('multiplies by a quantity', () => {
      expect(ghs('19.99').times(3).toString()).toBe('59.97');
      expect(ghs('2.50').times('1.250').amount.toString()).toBe('3.125');
    });

    it.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['equals', (a: Money, b: Money) => a.equals(b)],
      ['greaterThan', (a: Money, b: Money) => a.greaterThan(b)],
      ['lessThanOrEqual', (a: Money, b: Money) => a.lessThanOrEqual(b)],
      ['max', (a: Money, b: Money) => Money.max(a, b)],
    ])('refuses to %s amounts in different currencies', (_name, combine) => {
      expect(() => combine(ghs(1), Money.of(1, 'USD'))).toThrow('Cannot combine GHS and USD amounts');
    });
  });

  describe('rounding (half-up, 2 dp)', () => {
    it.each([
      ['1.005', '1.01'],
      ['1.004', '1.00'],
      ['2.675', '2.68'],
      ['0.125', '0.13'],
      ['-1.005', '-1.01'],
      ['-0.004', '0.00'],
      ['10', '10.00'],
    ])('rounds %s to %s', (value, expected) => {
      expect(ghs(value).roundHalfUp().toString()).toBe(expected);
      expect(ghs(value).toString()).toBe(expected);
    });

    it('applies a rate and rounds the result half-up by default', () => {
      expect(ghs('10.05').applyRate('0.15').toString()).toBe('1.51');
      expect(ghs('10.05').applyRate('0.15').amount.toString()).toBe('1.51');
    });

    it('can leave a rate unrounded for an intermediate step', () => {
      expect(ghs('10.05').applyRate('0.15', 'NONE').amount.toString()).toBe('1.5075');
    });

    it('gives the same cent as Postgres ROUND(numeric, 2) for every amount to 3 dp', () => {
      for (let thousandths = -2000; thousandths <= 2000; thousandths++) {
        const value = new Decimal(thousandths).div(1000);
        const expected = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        expect(ghs(value).roundHalfUp().amount.equals(expected)).toBe(true);
      }
    });
  });

  describe('comparisons', () => {
    it('compares amounts of one currency', () => {
      expect(ghs('5.00').equals(ghs(5))).toBe(true);
      expect(ghs(5).greaterThan(ghs('4.99'))).toBe(true);
      expect(ghs(5).greaterThanOrEqual(ghs(5))).toBe(true);
      expect(ghs(5).lessThan(ghs('5.01'))).toBe(true);
      expect(ghs(5).lessThanOrEqual(ghs(5))).toBe(true);
      expect(Money.max(ghs(1), ghs(2)).toString()).toBe('2.00');
      expect(Money.min(ghs(1), ghs(2)).toString()).toBe('1.00');
    });

    it('treats zero as neither negative nor positive', () => {
      expect(ghs(0).isNegative()).toBe(false);
      expect(ghs('-0').isNegative()).toBe(false);
      expect(ghs(0).isPositive()).toBe(false);
      expect(ghs('-0.01').isNegative()).toBe(true);
      expect(ghs('0.01').isPositive()).toBe(true);
    });
  });

  describe('toMinorUnits', () => {
    it.each([
      ['1000.50', 100050],
      ['0.01', 1],
      ['0', 0],
      ['19.9', 1990],
      ['1234567890.12', 123456789012],
    ])('converts %s to %d pesewas', (value, expected) => {
      expect(ghs(value).toMinorUnits()).toBe(expected);
    });

    it('converts amounts that float maths gets wrong', () => {
      expect(ghs('1.15').toMinorUnits()).toBe(115);
      expect(ghs('4.35').toMinorUnits()).toBe(435);
      expect(ghs('8.20').toMinorUnits()).toBe(820);
    });

    it.each(['1.005', '0.001', '19.999'])('refuses %s, which is not a whole number of pesewas', (value) => {
      expect(() => ghs(value).toMinorUnits()).toThrow('is not a whole number of minor units');
    });
  });

  describe('allocate', () => {
    const amounts = (parts: Money[]) => parts.map((part) => part.toString());

    it('splits evenly when it can', () => {
      expect(amounts(ghs('9.00').allocate([1, 1, 1]))).toEqual(['3.00', '3.00', '3.00']);
    });

    it('gives the leftover pesewa to the largest remainder', () => {
      expect(amounts(ghs('10.00').allocate([1, 1, 1]))).toEqual(['3.34', '3.33', '3.33']);
      expect(amounts(ghs('0.05').allocate([1, 3]))).toEqual(['0.01', '0.04']);
      expect(amounts(ghs('0.05').allocate([3, 7]))).toEqual(['0.02', '0.03']);
      expect(amounts(ghs('100.00').allocate([1, 2, 3]))).toEqual(['16.67', '33.33', '50.00']);
    });

    it('breaks remainder ties in favour of the earlier part', () => {
      expect(amounts(ghs('0.02').allocate([1, 1, 1]))).toEqual(['0.01', '0.01', '0.00']);
    });

    it('allocates in proportion to decimal weights such as line totals', () => {
      expect(amounts(ghs('10.00').allocate(['19.99', '5.01']))).toEqual(['8.00', '2.00']);
    });

    it('gives nothing to a zero weight', () => {
      expect(amounts(ghs('10.00').allocate([0, 1, 0, 1]))).toEqual(['0.00', '5.00', '0.00', '5.00']);
    });

    it('allocates zero as zeros', () => {
      expect(amounts(ghs(0).allocate([1, 2]))).toEqual(['0.00', '0.00']);
    });

    it('keeps the currency on every part', () => {
      expect(
        Money.of('1.00', 'USD')
          .allocate([1, 1])
          .map((part) => part.currency),
      ).toEqual(['USD', 'USD']);
    });

    it.each([[[]], [[0, 0]], [[1, -1]], [[1, Infinity]]])('refuses the weights %p', (weights) => {
      expect(() => ghs(10).allocate(weights)).toThrow(RangeError);
    });

    it('refuses a negative amount', () => {
      expect(() => ghs('-10.00').allocate([1, 1])).toThrow('Cannot allocate a negative amount');
    });

    it('refuses an amount with more than 2 decimal places', () => {
      expect(() => ghs('10.005').allocate([1, 1])).toThrow('is not a whole number of minor units');
    });

    it('always returns parts that add up exactly to the amount and are within a pesewa of their share', () => {
      const next = sequence(42);
      for (let run = 0; run < 500; run++) {
        const amount = ghs(new Decimal(next(10_000_000)).div(100));
        const weights = Array.from({ length: 1 + next(8) }, () => (next(5) === 0 ? 0 : next(100_000)));
        if (!weights.some((weight) => weight > 0)) weights[0] = 1;
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

        const parts = amount.allocate(weights);

        expect(parts.reduce((sum, part) => sum.add(part), Money.zero('GHS')).equals(amount)).toBe(true);
        parts.forEach((part, index) => {
          const share = amount.amount.mul(weights[index]).div(totalWeight);
          expect(part.amount.sub(share).abs().lt('0.01')).toBe(true);
          expect(part.isNegative()).toBe(false);
          expect(() => part.toMinorUnits()).not.toThrow();
        });
      }
    });
  });

  describe('standalone helpers for code that holds a bare Decimal', () => {
    it('rounds with the same half-up rule as Money', () => {
      expect(roundHalfUp('2.675').toString()).toBe('2.68');
      expect(roundHalfUp(new Decimal('-0.005')).toString()).toBe('-0.01');
    });

    it('converts to minor units, refusing fractions of a pesewa', () => {
      expect(toMinorUnits(new Decimal('8.20'))).toBe(820);
      expect(() => toMinorUnits('8.205')).toThrow('is not a whole number of minor units');
    });

    it('refuses an amount too large to send as a safe integer', () => {
      expect(() => toMinorUnits('99999999999999999')).toThrow('too large');
    });
  });
});
