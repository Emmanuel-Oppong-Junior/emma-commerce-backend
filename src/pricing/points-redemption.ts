import { Decimal } from '@prisma/client/runtime/client';

/** The customer's loyalty points and the store's redemption rules (P6-L.1), read with the cart. */
export interface PricingLoyalty {
  /** The store runs the loyalty programme; when off, points cannot be redeemed. */
  enabled: boolean;
  /** Points the customer can spend now. */
  balance: number;
  /** Points worth GHS 1 (100: one point is one pesewa). */
  redeemPointsPerCedi: number;
  /** The fewest points one redemption may use. */
  minimumRedeemPoints: number;
  /** Points may pay at most this percentage of the goods after promotions (delivery excluded). */
  maxRedeemPercent: number;
}

export enum PointsRefusal {
  /** No loyalty account at checkout (a guest). */
  NOT_A_MEMBER = 'NOT_A_MEMBER',
  LOYALTY_DISABLED = 'LOYALTY_DISABLED',
  POINTS_BELOW_MINIMUM = 'POINTS_BELOW_MINIMUM',
  INSUFFICIENT_POINTS = 'INSUFFICIENT_POINTS',
  POINTS_ABOVE_CAP = 'POINTS_ABOVE_CAP',
  /** The points are not worth a whole number of pesewas at the store's rate. */
  POINTS_NOT_WHOLE_PESEWAS = 'POINTS_NOT_WHOLE_PESEWAS',
}

/** The points cannot be redeemed on this cart; the message is safe to show the customer. */
export class PointsNotRedeemableError extends Error {
  constructor(
    readonly reason: PointsRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** What `points` are worth in cedis at `pointsPerCedi`, exactly (not rounded). */
export function pointsValue(points: number, pointsPerCedi: number): Decimal {
  return new Decimal(points).div(pointsPerCedi);
}

/** The most points may pay on goods worth `goods`: maxRedeemPercent of it, rounded down to the pesewa. */
export function redemptionCap(goods: Decimal, maxRedeemPercent: number): Decimal {
  return goods.mul(maxRedeemPercent).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

/** The smallest number of points worth whole pesewas: every redeemable amount is a multiple of it. */
function pointsStep(pointsPerCedi: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return pointsPerCedi / gcd(pointsPerCedi, 100);
}

/**
 * The most points the customer can redeem on goods worth `goods` (after promotions, delivery excluded): within their
 * balance and the cap, worth whole pesewas; 0 when that is below the minimum or loyalty is off.
 */
export function maxRedeemablePoints(goods: Decimal, loyalty: PricingLoyalty): number {
  if (!loyalty.enabled) return 0;
  const step = pointsStep(loyalty.redeemPointsPerCedi);
  const pointsByCap = redemptionCap(goods, loyalty.maxRedeemPercent).mul(loyalty.redeemPointsPerCedi).floor();
  // eslint-disable-next-line no-restricted-syntax -- a count of points, not money
  const byCap = pointsByCap.toNumber();
  const most = Math.floor(Math.min(loyalty.balance, byCap) / step) * step;
  return most >= loyalty.minimumRedeemPoints ? most : 0;
}

/**
 * What redeeming `points` takes off goods worth `goods`, or PointsNotRedeemableError: loyalty must be on, the points a
 * whole number from the minimum, within the balance, worth whole pesewas and at most the cap.
 */
export function redemptionAmount(points: number, goods: Decimal, loyalty: PricingLoyalty | null): Decimal {
  if (!loyalty) throw new PointsNotRedeemableError(PointsRefusal.NOT_A_MEMBER, 'Sign in to redeem loyalty points');
  if (!loyalty.enabled) {
    throw new PointsNotRedeemableError(PointsRefusal.LOYALTY_DISABLED, 'Loyalty points cannot be redeemed right now');
  }
  if (!Number.isInteger(points) || points < loyalty.minimumRedeemPoints) {
    throw new PointsNotRedeemableError(
      PointsRefusal.POINTS_BELOW_MINIMUM,
      `Redeem at least ${loyalty.minimumRedeemPoints} points, as a whole number (got ${points})`,
    );
  }
  if (points > loyalty.balance) {
    throw new PointsNotRedeemableError(
      PointsRefusal.INSUFFICIENT_POINTS,
      `You have ${loyalty.balance} points; ${points} requested`,
    );
  }
  const amount = pointsValue(points, loyalty.redeemPointsPerCedi);
  if (!amount.equals(amount.toDecimalPlaces(2))) {
    throw new PointsNotRedeemableError(
      PointsRefusal.POINTS_NOT_WHOLE_PESEWAS,
      `Redeem points in multiples of ${pointsStep(loyalty.redeemPointsPerCedi)}`,
    );
  }
  const cap = redemptionCap(goods, loyalty.maxRedeemPercent);
  if (amount.gt(cap)) {
    throw new PointsNotRedeemableError(
      PointsRefusal.POINTS_ABOVE_CAP,
      `Points can pay at most ${loyalty.maxRedeemPercent}% of the goods (${cap.toFixed(2)}); ${points} points are worth ${amount.toFixed(2)}`,
    );
  }
  return amount;
}
