import { Decimal } from '@prisma/client/runtime/client';
import { OrderStatus } from '../generated/prisma/client';
import {
  addMonths,
  drawPoints,
  earnedPoints,
  EarnRefusal,
  earnRefusal,
  giveBackDraws,
  orderSettlement,
  paidGoods,
  payDebtFirst,
  refundedShare,
} from './loyalty-rules';

const d = (value: Decimal.Value) => new Decimal(value);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('loyalty rules (P6-L.1)', () => {
  describe('earning', () => {
    it('counts the goods paid after every promotion and the points, without the delivery fee', () => {
      const paid = paidGoods([
        { lineTotal: d('100.00'), orderAdjustmentShare: d('-12.50') },
        { lineTotal: d('40.99'), orderAdjustmentShare: d('-3.00') },
      ]);
      expect(paid).toEqual(d('125.49'));
    });

    it('rounds down once per order, at the store rate', () => {
      expect(earnedPoints(d('125.99'), 1)).toBe(125);
      expect(earnedPoints(d('0.99'), 1)).toBe(0);
      expect(earnedPoints(d('10.50'), 3)).toBe(31);
      expect(earnedPoints(d('0'), 5)).toBe(0);
    });

    it('never earns for guest orders (also once attached), staff accounts, or while loyalty is off', () => {
      expect(earnRefusal({ guestPhone: null, isStaff: false, enabled: true })).toBeNull();
      expect(earnRefusal({ guestPhone: '+233244000000', isStaff: false, enabled: true })).toBe(EarnRefusal.GUEST_ORDER);
      expect(earnRefusal({ guestPhone: null, isStaff: true, enabled: true })).toBe(EarnRefusal.STAFF_ACCOUNT);
      expect(earnRefusal({ guestPhone: null, isStaff: false, enabled: false })).toBe(EarnRefusal.LOYALTY_DISABLED);
    });
  });

  describe('refunds', () => {
    it('takes back the points of the goods refunded, rounded down and cumulative, all of them on a full refund', () => {
      expect(refundedShare(125, d('40.00'), d('125.49'))).toBe(39);
      expect(refundedShare(125, d('125.49'), d('125.49'))).toBe(125);
      expect(refundedShare(125, d('0'), d('125.49'))).toBe(0);
      expect(refundedShare(0, d('50'), d('125.49'))).toBe(0);
    });

    it('settles an order once: repeating it with the same ledger and refunds owes nothing more', () => {
      const order = { status: OrderStatus.COMPLETED, paid: d('100'), refunded: d('50') };
      const first = orderSettlement({ earned: 100, reversed: 0, redeemed: 600, returned: 0 }, order);
      expect(first).toEqual({ reverse: 50, giveBack: 300 });
      expect(orderSettlement({ earned: 100, reversed: 50, redeemed: 600, returned: 300 }, order)).toEqual({
        reverse: 0,
        giveBack: 0,
      });
    });

    it('gives every redeemed point back once the order is cancelled or expired, and earns nothing back', () => {
      for (const status of [OrderStatus.CANCELLED, OrderStatus.EXPIRED]) {
        expect(
          orderSettlement(
            { earned: 0, reversed: 0, redeemed: 700, returned: 0 },
            { status, paid: d('80'), refunded: d(0) },
          ),
        ).toEqual({ reverse: 0, giveBack: 700 });
      }
    });
  });

  describe('spending (FIFO) and expiry', () => {
    const lots = [
      { id: 'late', remaining: 300, expiresAt: day('2027-06-01'), createdAt: day('2026-06-01') },
      { id: 'early', remaining: 200, expiresAt: day('2027-01-01'), createdAt: day('2026-01-01') },
      { id: 'mid', remaining: 100, expiresAt: day('2027-03-01'), createdAt: day('2026-03-01') },
    ];

    it('spends the oldest-expiring points first', () => {
      expect(drawPoints(lots, 250)).toEqual({
        draws: [
          { lotId: 'early', points: 200 },
          { lotId: 'mid', points: 50 },
        ],
        shortfall: 0,
      });
    });

    it('takes a named lot first (a reversal takes the order’s own points), and reports a shortfall', () => {
      expect(drawPoints(lots, 700, 'late')).toEqual({
        draws: [
          { lotId: 'late', points: 300 },
          { lotId: 'early', points: 200 },
          { lotId: 'mid', points: 100 },
        ],
        shortfall: 100,
      });
    });

    it('gives redeemed points back to the lots they came from, latest expiry first, never twice', () => {
      const draws = [
        { lotId: 'early', points: 200, expiresAt: '2027-01-01T00:00:00.000Z' },
        { lotId: 'mid', points: 50, expiresAt: '2027-03-01T00:00:00.000Z' },
      ];
      expect(giveBackDraws(draws, 0, 100)).toEqual([
        { lotId: 'mid', points: 50 },
        { lotId: 'early', points: 50 },
      ]);
      expect(giveBackDraws(draws, 100, 150)).toEqual([{ lotId: 'early', points: 150 }]);
      expect(() => giveBackDraws(draws, 200, 100)).toThrow('Cannot give back 100 points');
    });

    it('pays points owed from the next points credited', () => {
      expect(payDebtFirst(500, 120)).toEqual({ repaid: 120, kept: 380 });
      expect(payDebtFirst(50, 120)).toEqual({ repaid: 50, kept: 0 });
      expect(payDebtFirst(50, 0)).toEqual({ repaid: 0, kept: 50 });
    });

    it('expires points 12 calendar months after they were credited, on the month’s last day when shorter', () => {
      expect(addMonths(new Date('2026-11-25T10:30:00.000Z'), 12)).toEqual(new Date('2027-11-25T10:30:00.000Z'));
      expect(addMonths(new Date('2027-01-31T00:00:00.000Z'), 1)).toEqual(new Date('2027-02-28T00:00:00.000Z'));
      expect(addMonths(new Date('2028-02-29T00:00:00.000Z'), 12)).toEqual(new Date('2029-02-28T00:00:00.000Z'));
    });
  });
});
