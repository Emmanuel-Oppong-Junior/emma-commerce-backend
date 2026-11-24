import { Prisma, ReturnReason, ReturnResolution } from '../generated/prisma/client';
import { planRefund, RefundableOrder } from './refund-plan';
import {
  checkReturnLines,
  exchangeRefusal,
  inspectionProblem,
  LineUnits,
  NOT_DELIVERED,
  NOT_RETURNABLE,
  OUTSIDE_RETURN_WINDOW,
  receiptProblem,
  replacementLines,
  RETURN_QUANTITY_EXCEEDED,
  returnableInWindow,
  returnableUnits,
  returnLineRefusal,
  returnRefundParts,
  ReturnPolicy,
  windowDaysFor,
} from './return-rules';

const d = (value: string | number) => new Prisma.Decimal(value);
const NOW = new Date('2026-12-20T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const policy = (overrides: Partial<ReturnPolicy['productType']> = {}, storeWindowDays = 14): ReturnPolicy => ({
  storeWindowDays,
  productType: { name: 'General', returnable: true, returnWindowDays: null, ...overrides },
});
const units = (overrides: Partial<LineUnits> = {}): LineUnits => ({
  deliveries: [{ deliveredAt: daysAgo(3), quantity: 3 }],
  refundedOutsideReturns: 0,
  claimedByReturns: 0,
  ...overrides,
});
const line = (quantity: number) => ({ orderItemId: 'oi1', productName: 'Kettle', quantity });

describe('return window', () => {
  it("uses the product type's window, else the store's", () => {
    expect(windowDaysFor(policy())).toBe(14);
    expect(windowDaysFor(policy({ returnWindowDays: 30 }))).toBe(30);
    expect(windowDaysFor(policy({ returnWindowDays: 0 }))).toBe(0);
  });

  it('counts units of shipments delivered within the window, inclusive of its last moment', () => {
    const split = units({
      deliveries: [
        { deliveredAt: daysAgo(20), quantity: 2 },
        { deliveredAt: daysAgo(14), quantity: 1 },
        { deliveredAt: daysAgo(2), quantity: 4 },
      ],
    });
    expect(returnableInWindow(split, 14, NOW)).toBe(5);
    expect(returnableInWindow(split, 30, NOW)).toBe(7);
  });

  it('leaves a delivery without a recorded time outside the window', () => {
    expect(returnableInWindow(units({ deliveries: [{ deliveredAt: null, quantity: 3 }] }), 14, NOW)).toBe(0);
  });

  it('counts units already refunded or returned against shipments outside the window first', () => {
    const split = units({
      deliveries: [
        { deliveredAt: daysAgo(30), quantity: 2 },
        { deliveredAt: daysAgo(1), quantity: 2 },
      ],
      claimedByReturns: 1,
      refundedOutsideReturns: 2,
    });
    expect(returnableUnits(split)).toBe(1);
    expect(returnableInWindow(split, 14, NOW)).toBe(1);
  });
});

describe('returnLineRefusal', () => {
  it('accepts units delivered within the window', () => {
    expect(returnLineRefusal(line(3), units(), policy(), NOW)).toBeNull();
  });

  it('refuses a non-returnable product type with BAD_REQUEST', () => {
    expect(returnLineRefusal(line(1), units(), policy({ returnable: false, name: 'Groceries' }), NOW)).toMatchObject({
      kind: 'BAD_REQUEST',
      reason: NOT_RETURNABLE,
      message: expect.stringMatching(/Groceries product, which cannot be returned/),
    });
  });

  it('refuses units outside the window with BAD_REQUEST', () => {
    const late = units({ deliveries: [{ deliveredAt: daysAgo(15), quantity: 3 }] });
    expect(returnLineRefusal(line(1), late, policy(), NOW)).toMatchObject({
      kind: 'BAD_REQUEST',
      reason: OUTSIDE_RETURN_WINDOW,
    });
    expect(returnLineRefusal(line(1), late, policy({ returnWindowDays: 30 }), NOW)).toBeNull();
  });

  it('refuses a line with nothing delivered', () => {
    expect(returnLineRefusal(line(1), units({ deliveries: [] }), policy(), NOW)).toMatchObject({
      reason: NOT_DELIVERED,
    });
  });

  it('caps units at delivered minus refunded and claimed, with CONFLICT', () => {
    const taken = units({ refundedOutsideReturns: 1, claimedByReturns: 1 });
    expect(returnLineRefusal(line(1), taken, policy(), NOW)).toBeNull();
    expect(returnLineRefusal(line(2), taken, policy(), NOW)).toMatchObject({
      kind: 'CONFLICT',
      reason: RETURN_QUANTITY_EXCEEDED,
      message: expect.stringMatching(/1 delivered units left to return; 2 requested/),
    });
  });

  it('lets a staff override skip the window and the returnable flag but never the units delivered', () => {
    const late = units({ deliveries: [{ deliveredAt: daysAgo(90), quantity: 2 }] });
    const closed = policy({ returnable: false });
    expect(returnLineRefusal(line(2), late, closed, NOW, true)).toBeNull();
    expect(returnLineRefusal(line(3), late, closed, NOW, true)).toMatchObject({ reason: RETURN_QUANTITY_EXCEEDED });
  });
});

describe('checkReturnLines', () => {
  const base = { orderItemId: 'oi1', quantity: 1, reason: ReturnReason.DAMAGED };

  it('normalises notes and photos', () => {
    expect(
      checkReturnLines('o1', ReturnResolution.REFUND, [
        { ...base, note: '  cracked  ', photoPublicIds: ['returns/o1/a'] },
      ]),
    ).toEqual([{ ...base, note: 'cracked', photoPublicIds: ['returns/o1/a'], exchangeVariantId: null }]);
  });

  it.each([
    [[], /at least one order line/],
    [[base, base], /listed more than once/],
    [[{ ...base, quantity: 0 }], /at least 1/],
    [[{ ...base, reason: ReturnReason.OTHER, note: ' ' }], /note is required/],
    [[{ ...base, photoPublicIds: ['returns/o1/a', 'returns/o1/b', 'returns/o1/c', 'returns/o1/d'] }], /At most 3/],
    [[{ ...base, photoPublicIds: ['returns/o2/a'] }], /not uploaded for order "o1"/],
    [[{ ...base, exchangeVariantId: 'v2' }], /names no exchange variant/],
  ])('refuses %j', (lines, message) => {
    expect(checkReturnLines('o1', ReturnResolution.REFUND, lines)).toMatch(message);
  });

  it('requires the wanted variant on every line of an exchange', () => {
    expect(checkReturnLines('o1', ReturnResolution.EXCHANGE, [base])).toMatch(/names the variant wanted/);
    expect(checkReturnLines('o1', ReturnResolution.EXCHANGE, [{ ...base, exchangeVariantId: 'v2' }])).toEqual([
      expect.objectContaining({ exchangeVariantId: 'v2' }),
    ]);
  });
});

describe('exchangeRefusal', () => {
  const ordered = { orderItemId: 'oi1', productId: 'p1', unitListPrice: d('120.00') };
  const candidate = { id: 'v2', productId: 'p1', price: d('120'), notSellable: null };

  it('allows a variant of the same product at the price the line was ordered at', () => {
    expect(exchangeRefusal(ordered, candidate)).toBeNull();
  });

  it.each([
    [{ ...candidate, productId: 'p2' }, /not a variant of the product/],
    [{ ...candidate, price: d('125') }, /costs 125\.00.*only an exchange at the same price/],
    [{ ...candidate, price: null }, /costs nothing/],
    [{ ...candidate, notSellable: 'the product is archived' }, /cannot be sold: the product is archived/],
  ])('refuses %j', (replacement, message) => {
    expect(exchangeRefusal(ordered, replacement)).toMatch(message);
  });
});

describe('receipt and inspection', () => {
  const lines = [
    { id: 'l1', quantity: 2 },
    { id: 'l2', quantity: 1 },
  ];

  it('accepts a short receipt that lists every line', () => {
    expect(
      receiptProblem(lines, [
        { returnLineId: 'l1', receivedQuantity: 1 },
        { returnLineId: 'l2', receivedQuantity: 0 },
      ]),
    ).toBeNull();
  });

  it.each([
    [[{ returnLineId: 'l1', receivedQuantity: 3 }], /returns 2 units; 3 received/],
    [[{ returnLineId: 'l1', receivedQuantity: 1 }], /return line "l2" arrived/],
    [[{ returnLineId: 'x', receivedQuantity: 1 }], /not part of this return/],
    [
      [
        { returnLineId: 'l1', receivedQuantity: 0 },
        { returnLineId: 'l2', receivedQuantity: 0 },
      ],
      /Nothing arrived/,
    ],
  ])('refuses the receipt %j', (received, message) => {
    expect(receiptProblem(lines, received)).toMatch(message);
  });

  it('requires restock and write-off to add up to what each line received', () => {
    const received = [
      { id: 'l1', receivedQuantity: 2 },
      { id: 'l2', receivedQuantity: 0 },
    ];
    expect(inspectionProblem(received, [{ returnLineId: 'l1', restockQuantity: 1, writeOffQuantity: 1 }])).toBeNull();
    expect(inspectionProblem(received, [{ returnLineId: 'l1', restockQuantity: 2, writeOffQuantity: 1 }])).toMatch(
      /add up to that, got 2 \+ 1/,
    );
    expect(inspectionProblem(received, [])).toMatch(/return line "l1"/);
  });
});

describe('refund and replacement of a return', () => {
  const order: RefundableOrder = {
    pricingVersion: 5,
    grandTotal: d('230'),
    taxLineAmounts: [],
    refundedTax: [],
    currency: 'GHS',
    shippingTotal: d('20'),
    shippingRefunded: false,
    refundable: d('230'),
    lines: [
      {
        id: 'oi1',
        quantity: 2,
        lineTotal: d('200'),
        orderAdjustmentShare: d('-20'),
        taxLineAmounts: [],
        refundedQuantity: 0,
      },
      {
        id: 'oi2',
        quantity: 1,
        lineTotal: d('30'),
        orderAdjustmentShare: d('0'),
        taxLineAmounts: [],
        refundedQuantity: 0,
      },
    ],
  };

  it('refunds only the units received, at what the order stored for them, without the delivery fee', () => {
    const parts = returnRefundParts(
      [
        { orderItemId: 'oi1', receivedQuantity: 1 },
        { orderItemId: 'oi2', receivedQuantity: 0 },
      ],
      false,
    );
    const plan = planRefund(order, parts);

    expect(parts.lines).toEqual([{ orderItemId: 'oi1', quantity: 1 }]);
    expect(plan.amount.toFixed(2)).toBe('90.00');
    expect(plan.shippingAmount.toFixed(2)).toBe('0.00');
    expect(plan.lines).toEqual([{ orderItemId: 'oi1', quantity: 1, amount: d('90') }]);
  });

  it('adds the delivery fee when staff choose it', () => {
    const plan = planRefund(order, returnRefundParts([{ orderItemId: 'oi2', receivedQuantity: 1 }], true));
    expect(plan.amount.toFixed(2)).toBe('50.00');
  });

  it('replaces each unit received with the variant wanted', () => {
    expect(
      replacementLines([
        { orderItemId: 'oi1', exchangeVariantId: 'v2', receivedQuantity: 2 },
        { orderItemId: 'oi2', exchangeVariantId: 'v3', receivedQuantity: 0 },
      ]),
    ).toEqual([{ orderItemId: 'oi1', variantId: 'v2', quantity: 2 }]);
  });
});
