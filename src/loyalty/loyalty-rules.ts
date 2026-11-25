import { Decimal } from '@prisma/client/runtime/client';
import { OrderStatus } from '../generated/prisma/client';

/** An order line as stored at placement: its total and its share of the order adjustments (points included, <= 0). */
export interface PaidLine {
  lineTotal: Decimal;
  orderAdjustmentShare: Decimal;
}

/** What the customer paid for the goods: the line totals after every promotion and the points, delivery excluded. */
export function paidGoods(lines: readonly PaidLine[]): Decimal {
  return lines.reduce((sum, line) => sum.add(line.lineTotal).add(line.orderAdjustmentShare), new Decimal(0));
}

/** Points an order earns: `pointsPerCedi` per whole GHS 1 of goods paid, rounded down once per order. */
export function earnedPoints(paid: Decimal, pointsPerCedi: number): number {
  return paid.lte(0) ? 0 : paid.mul(pointsPerCedi).floor().toNumber();
}

/**
 * The part of `total` points that follows `refunded` of the `paid` goods, rounded down. Cumulative: later refunds take
 * the difference, and a full refund takes exactly `total`.
 */
export function refundedShare(total: number, refunded: Decimal, paid: Decimal): number {
  if (total <= 0 || refunded.lte(0)) return 0;
  if (paid.lte(0) || refunded.gte(paid)) return total;
  return new Decimal(total).mul(refunded).div(paid).floor().toNumber();
}

export enum EarnRefusal {
  GUEST_ORDER = 'GUEST_ORDER',
  STAFF_ACCOUNT = 'STAFF_ACCOUNT',
  LOYALTY_DISABLED = 'LOYALTY_DISABLED',
}

/**
 * Why a COMPLETED order earns nothing, or null when it earns: guest orders never do, also once attached to an account
 * (they keep their guest phone), nor staff accounts, nor anything while the programme is off.
 */
export function earnRefusal(facts: {
  guestPhone: string | null;
  isStaff: boolean;
  enabled: boolean;
}): EarnRefusal | null {
  if (facts.guestPhone !== null) return EarnRefusal.GUEST_ORDER;
  if (facts.isStaff) return EarnRefusal.STAFF_ACCOUNT;
  if (!facts.enabled) return EarnRefusal.LOYALTY_DISABLED;
  return null;
}

/** What the ledger already holds for one order. */
export interface OrderLedger {
  earned: number;
  /** Earned points taken back, from the balance or as debt. */
  reversed: number;
  redeemed: number;
  /** Redeemed points given back. */
  returned: number;
}

/**
 * What an order's loyalty still owes after a status change or a refund: earned points to take back in proportion to
 * the goods refunded, and redeemed points to give back (all of them once the order is cancelled or expired, otherwise
 * in proportion to the goods refunded). Never negative, so applying it twice changes nothing.
 */
export function orderSettlement(
  ledger: OrderLedger,
  order: { status: OrderStatus; paid: Decimal; refunded: Decimal },
): { reverse: number; giveBack: number } {
  const closed = order.status === OrderStatus.CANCELLED || order.status === OrderStatus.EXPIRED;
  const giveBackTarget = closed ? ledger.redeemed : refundedShare(ledger.redeemed, order.refunded, order.paid);
  const reverseTarget = refundedShare(ledger.earned, order.refunded, order.paid);
  return {
    reverse: Math.max(0, reverseTarget - ledger.reversed),
    giveBack: Math.max(0, giveBackTarget - ledger.returned),
  };
}

export interface SpendableLot {
  id: string;
  remaining: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface Draw {
  lotId: string;
  points: number;
}

/**
 * Takes `points` from the lots, the one named `first` before the others, then oldest expiry first (then the oldest
 * lot); `shortfall` is what the lots could not cover.
 */
export function drawPoints(
  lots: readonly SpendableLot[],
  points: number,
  first?: string,
): { draws: Draw[]; shortfall: number } {
  const ordered = [...lots].sort(
    (a, b) =>
      Number(b.id === first) - Number(a.id === first) ||
      a.expiresAt.getTime() - b.expiresAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let left = points;
  const draws: Draw[] = [];
  for (const lot of ordered) {
    const taken = Math.min(lot.remaining, left);
    if (taken > 0) draws.push({ lotId: lot.id, points: taken });
    left -= taken;
  }
  return { draws, shortfall: left };
}

export interface RecordedDraw extends Draw {
  expiresAt: string;
}

/**
 * Where `points` redeemed points go back to: the lots the redemption drew from, latest expiry first (the customer
 * keeps the longest-lived points), skipping the `alreadyReturned` points earlier give-backs took.
 */
export function giveBackDraws(draws: readonly RecordedDraw[], alreadyReturned: number, points: number): Draw[] {
  const ordered = [...draws].sort(
    (a, b) => b.expiresAt.localeCompare(a.expiresAt) || (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0),
  );
  let skip = alreadyReturned;
  let left = points;
  const back: Draw[] = [];
  for (const draw of ordered) {
    const skipped = Math.min(skip, draw.points);
    skip -= skipped;
    const taken = Math.min(draw.points - skipped, left);
    if (taken > 0) back.push({ lotId: draw.lotId, points: taken });
    left -= taken;
  }
  if (left > 0) throw new Error(`Cannot give back ${points} points: only ${points - left} were drawn and not returned`);
  return back;
}

/** Points credited to an account that owes points pay the debt first; the rest goes into the new lot. */
export function payDebtFirst(points: number, debt: number): { repaid: number; kept: number } {
  const repaid = Math.min(points, debt);
  return { repaid, kept: points - repaid };
}

/** `months` calendar months after `from` (UTC), on the last day of the month when it is shorter. */
export function addMonths(from: Date, months: number): Date {
  const target = new Date(from.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
