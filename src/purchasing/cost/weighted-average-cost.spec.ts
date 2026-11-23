import { Decimal } from '@prisma/client/runtime/client';
import { weightedAverageCost } from './weighted-average-cost';

const d = (value: string) => new Decimal(value);

describe('weightedAverageCost', () => {
  it('takes the unit cost when the old cost is unknown', () => {
    expect(weightedAverageCost(null, 40, 10, d('3.5')).toFixed()).toBe('3.5');
  });

  it.each([0, -3])('takes the unit cost when %i units were on hand', (onHand) => {
    expect(weightedAverageCost(d('9.99'), onHand, 5, d('4.25')).toFixed()).toBe('4.25');
  });

  it('weights the old cost by the units on hand and the new cost by the units received', () => {
    // (10 × 5.00 + 5 × 8.00) / 15 = 6
    expect(weightedAverageCost(d('5.00'), 10, 5, d('8.00')).toFixed()).toBe('6');
  });

  it('rounds half-up to 4 decimal places', () => {
    // (2 × 1 + 1 × 2) / 3 = 1.33333...
    expect(weightedAverageCost(d('1'), 2, 1, d('2')).toFixed()).toBe('1.3333');
    // (1 × 1 + 2 × 2) / 3 = 1.66666...
    expect(weightedAverageCost(d('1'), 1, 2, d('2')).toFixed()).toBe('1.6667');
    // (1 × 0.0001 + 1 × 0.0002) / 2 = 0.00015 -> 0.0002
    expect(weightedAverageCost(d('0.0001'), 1, 1, d('0.0002')).toFixed()).toBe('0.0002');
  });

  it('keeps exact decimals where floats would drift', () => {
    // 0.1 and 0.2 are not exact in binary floating point; (3 × 0.1 + 3 × 0.2) / 6 = 0.15 exactly
    expect(weightedAverageCost(d('0.1'), 3, 3, d('0.2')).toFixed()).toBe('0.15');
  });

  it('refuses a receipt of no units', () => {
    expect(() => weightedAverageCost(d('1'), 1, 0, d('1'))).toThrow(RangeError);
  });
});
