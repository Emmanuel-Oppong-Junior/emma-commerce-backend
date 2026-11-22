import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { planRefund, RefundableLine, RefundableOrder, RefundRequestParts } from './refund-plan';

const d = (value: string) => new Prisma.Decimal(value);

// Line A: 3 x 115.00 (100 net + 15 tax), share of a GHS 30 cart coupon -20.00.
// Line B: 1 x 57.50 (50 net + 7.50 tax), share -10.00. Shipping 20.00. Charged 345 + 57.50 - 30 + 20 = 392.50.
const lineA = (overrides: Partial<RefundableLine> = {}): RefundableLine => ({
  id: 'a',
  quantity: 3,
  lineTotal: d('345.00'),
  orderAdjustmentShare: d('-20.00'),
  taxLineAmounts: [d('45.00')],
  refundedQuantity: 0,
  ...overrides,
});
const lineB = (overrides: Partial<RefundableLine> = {}): RefundableLine => ({
  id: 'b',
  quantity: 1,
  lineTotal: d('57.50'),
  orderAdjustmentShare: d('-10.00'),
  taxLineAmounts: [d('5.00'), d('2.50')],
  refundedQuantity: 0,
  ...overrides,
});
const order = (overrides: Partial<RefundableOrder> = {}): RefundableOrder => ({
  pricingVersion: 1,
  currency: 'GHS',
  grandTotal: d('392.50'),
  taxLineAmounts: [d('45.00'), d('5.00'), d('2.50')],
  refundedTax: [],
  shippingTotal: d('20.00'),
  shippingRefunded: false,
  lines: [lineA(), lineB()],
  refundable: d('392.50'),
  ...overrides,
});
const request = (overrides: Partial<RefundRequestParts> = {}): RefundRequestParts => ({
  lines: [],
  shipping: false,
  amount: null,
  ...overrides,
});
const fixed = (value: Prisma.Decimal | null) => value?.toFixed(2) ?? null;

describe('planRefund', () => {
  describe('line units', () => {
    it('refunds the stored unit price less the units share of the order adjustments, with their stored tax', () => {
      const plan = planRefund(order(), request({ lines: [{ orderItemId: 'a', quantity: 1 }] }));

      // 115.00 + round(-20 x 1/3) = 115.00 - 6.67
      expect(fixed(plan.amount)).toBe('108.33');
      expect(plan.lines.map((line) => [line.orderItemId, line.quantity, fixed(line.amount)])).toEqual([
        ['a', 1, '108.33'],
      ]);
      expect(fixed(plan.taxAmount)).toBe('15.00');
      expect(fixed(plan.shippingAmount)).toBe('0.00');
    });

    it('gives the remaining units exactly what is left of the line, so the parts add up to what was charged', () => {
      const first = planRefund(order(), request({ lines: [{ orderItemId: 'a', quantity: 1 }] }));
      const second = planRefund(
        order({ lines: [lineA({ refundedQuantity: 1 }), lineB()], refundedTax: [d('15.00')] }),
        request({ lines: [{ orderItemId: 'a', quantity: 1 }] }),
      );
      const third = planRefund(
        order({ lines: [lineA({ refundedQuantity: 2 }), lineB()], refundedTax: [d('15.00'), d('15.00')] }),
        request({ lines: [{ orderItemId: 'a', quantity: 1 }] }),
      );

      // round(-20 x 2/3) - round(-20 x 1/3) = -13.33 + 6.67 = -6.66; the last unit takes -20 + 13.33 = -6.67
      expect([first, second, third].map((plan) => fixed(plan.amount))).toEqual(['108.33', '108.34', '108.33']);
      expect(first.amount.add(second.amount).add(third.amount).toFixed(2)).toBe('325.00');
      expect([first, second, third].map((plan) => fixed(plan.taxAmount))).toEqual(['15.00', '15.00', '15.00']);
    });

    it('refunds several lines and the shipping fee in one request', () => {
      const plan = planRefund(
        order(),
        request({
          lines: [
            { orderItemId: 'a', quantity: 3 },
            { orderItemId: 'b', quantity: 1 },
          ],
          shipping: true,
        }),
      );

      expect(fixed(plan.amount)).toBe('392.50');
      expect(fixed(plan.shippingAmount)).toBe('20.00');
      expect(fixed(plan.taxAmount)).toBe('52.50');
      expect(plan.lines.map((line) => fixed(line.amount))).toEqual(['325.00', '47.50']);
    });

    it('refunds legacy lines at their stored line total, with no tax answer', () => {
      const legacy = order({
        pricingVersion: 0,
        taxLineAmounts: [],
        lines: [lineA({ orderAdjustmentShare: d('0'), taxLineAmounts: [] })],
      });

      const plan = planRefund(legacy, request({ lines: [{ orderItemId: 'a', quantity: 2 }] }));

      expect(fixed(plan.amount)).toBe('230.00');
      expect(plan.taxAmount).toBeNull();
    });

    it('refuses more units than the line has left, counting earlier refunds', () => {
      const partlyRefunded = order({ lines: [lineA({ refundedQuantity: 2 }), lineB()] });

      expect(() => planRefund(partlyRefunded, request({ lines: [{ orderItemId: 'a', quantity: 2 }] }))).toThrow(
        new ConflictException('Order line "a" has 1 of 3 units left to refund; 2 requested'),
      );
    });

    it('refuses unknown, repeated and non-positive lines', () => {
      expect(() => planRefund(order(), request({ lines: [{ orderItemId: 'x', quantity: 1 }] }))).toThrow(
        BadRequestException,
      );
      expect(() =>
        planRefund(
          order(),
          request({
            lines: [
              { orderItemId: 'a', quantity: 1 },
              { orderItemId: 'a', quantity: 1 },
            ],
          }),
        ),
      ).toThrow(/listed more than once/);
      expect(() => planRefund(order(), request({ lines: [{ orderItemId: 'a', quantity: 0 }] }))).toThrow(/at least 1/);
    });
  });

  describe('shipping fee', () => {
    it('refunds the stored fee, untaxed', () => {
      const plan = planRefund(order(), request({ shipping: true }));

      expect(fixed(plan.amount)).toBe('20.00');
      expect(fixed(plan.shippingAmount)).toBe('20.00');
      expect(fixed(plan.taxAmount)).toBe('0.00');
      expect(plan.lines).toEqual([]);
    });

    it('refunds the fee only once', () => {
      expect(() => planRefund(order({ shippingRefunded: true }), request({ shipping: true }))).toThrow(
        new ConflictException('The shipping fee of this order was already refunded'),
      );
    });

    it('refuses a fee the order never had (pickup, free shipping or unknown)', () => {
      expect(() => planRefund(order({ shippingTotal: d('0') }), request({ shipping: true }))).toThrow(
        BadRequestException,
      );
      expect(() => planRefund(order({ shippingTotal: null }), request({ shipping: true }))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('free amount', () => {
    it("takes the order's stored tax in proportion to the grand total", () => {
      const plan = planRefund(order(), request({ amount: d('100.00') }));

      // 52.50 x 100 / 392.50 = 13.375...
      expect(fixed(plan.amount)).toBe('100.00');
      expect(fixed(plan.taxAmount)).toBe('13.38');
    });

    it('adds to the lines and never refunds more tax than is left', () => {
      const plan = planRefund(
        order({ refundedTax: [d('50.00')] }),
        request({ lines: [{ orderItemId: 'b', quantity: 1 }], amount: d('10.00') }),
      );

      expect(fixed(plan.amount)).toBe('57.50');
      expect(fixed(plan.taxAmount)).toBe('2.50');
    });

    it('refuses a negative amount and an empty request', () => {
      expect(() => planRefund(order(), request({ amount: d('-1.00') }))).toThrow(BadRequestException);
      expect(() => planRefund(order(), request())).toThrow(
        new BadRequestException('Choose order lines, the shipping fee or an amount to refund'),
      );
      expect(() => planRefund(order(), request({ amount: d('0') }))).toThrow(BadRequestException);
    });
  });

  describe('payment cap', () => {
    it('refuses a refund above what the payment still holds, whatever refunded the rest (returns included)', () => {
      const afterReturn = order({ refundable: d('50.00') });

      expect(() => planRefund(afterReturn, request({ amount: d('50.01') }))).toThrow(
        new ConflictException("Refund of 50.01 GHS exceeds the 50.00 GHS still refundable on this order's payment"),
      );
      expect(fixed(planRefund(afterReturn, request({ amount: d('50.00') })).amount)).toBe('50.00');
      expect(() => planRefund(afterReturn, request({ lines: [{ orderItemId: 'a', quantity: 1 }] }))).toThrow(
        ConflictException,
      );
    });
  });
});
