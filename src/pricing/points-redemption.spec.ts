import { Decimal } from '@prisma/client/runtime/client';
import {
  maxRedeemablePoints,
  PointsNotRedeemableError,
  PointsRefusal,
  PricingLoyalty,
  redemptionAmount,
  redemptionCap,
} from './points-redemption';

const d = (value: Decimal.Value) => new Decimal(value);
const loyalty = (overrides: Partial<PricingLoyalty> = {}): PricingLoyalty => ({
  enabled: true,
  balance: 10_000,
  redeemPointsPerCedi: 100,
  minimumRedeemPoints: 500,
  maxRedeemPercent: 50,
  ...overrides,
});
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof PointsNotRedeemableError) return error.reason;
    throw error;
  }
  return null;
};

describe('points redemption (P6-L.1)', () => {
  it('values 100 points at GHS 1 and caps them at half the goods, rounded down to the pesewa', () => {
    expect(redemptionAmount(1_234, d('100'), loyalty())).toEqual(d('12.34'));
    expect(redemptionCap(d('33.33'), 50)).toEqual(d('16.66'));
  });

  it('finds the most points within the balance and cap, worth whole pesewas, from the minimum', () => {
    expect(maxRedeemablePoints(d('33.33'), loyalty())).toBe(1_666);
    expect(maxRedeemablePoints(d('100'), loyalty({ balance: 777 }))).toBe(777);
    expect(maxRedeemablePoints(d('9.98'), loyalty())).toBe(0);
    // 3 points per GHS 1: one point is not worth whole pesewas, three points are GHS 1.00.
    expect(
      maxRedeemablePoints(d('100'), loyalty({ redeemPointsPerCedi: 3, minimumRedeemPoints: 1, balance: 100 })),
    ).toBe(99);
  });

  it('refuses points worth fractions of a pesewa', () => {
    const odd = loyalty({ redeemPointsPerCedi: 3, minimumRedeemPoints: 1 });
    expect(refusal(() => redemptionAmount(10, d('100'), odd))).toBe(PointsRefusal.POINTS_NOT_WHOLE_PESEWAS);
    expect(redemptionAmount(9, d('100'), odd)).toEqual(d('3'));
  });

  it('refuses non-whole points as below the minimum', () => {
    expect(refusal(() => redemptionAmount(600.5, d('100'), loyalty()))).toBe(PointsRefusal.POINTS_BELOW_MINIMUM);
  });
});
