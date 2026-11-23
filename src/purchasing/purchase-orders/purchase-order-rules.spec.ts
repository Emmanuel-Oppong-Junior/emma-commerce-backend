import { Decimal } from '@prisma/client/runtime/client';
import { PurchaseOrderStatus } from '../../generated/prisma/client';
import { MAX_PURCHASE_ORDER_LINES, OrderedLine, purchaseOrderLinesProblem, receiptPlan } from './purchase-order-rules';

const S = PurchaseOrderStatus;
const line = (variantId: string, quantity: number, unitCost = '1.00') => ({
  variantId,
  quantity,
  unitCost: new Decimal(unitCost),
});

describe('purchaseOrderLinesProblem', () => {
  it('accepts valid lines, a zero cost included', () => {
    expect(purchaseOrderLinesProblem([line('a', 1, '0'), line('b', 3, '12.3456')])).toBeNull();
  });

  it.each([
    ['no lines', [], 'at least one line'],
    ['too many lines', Array.from({ length: MAX_PURCHASE_ORDER_LINES + 1 }, (_, i) => line(`v${i}`, 1)), 'at most'],
    ['a variant twice', [line('a', 1), line('a', 2)], 'only once'],
    ['a zero quantity', [line('a', 0)], 'at least 1'],
    ['a fractional quantity', [line('a', 1.5)], 'at least 1'],
    ['a negative cost', [line('a', 1, '-0.01')], 'Unit cost'],
    ['a cost with 5 decimals', [line('a', 1, '1.00001')], 'Unit cost'],
  ])('refuses %s', (_case, lines, message) => {
    expect(purchaseOrderLinesProblem(lines)).toContain(message);
  });
});

describe('receiptPlan', () => {
  const ordered: OrderedLine[] = [
    { id: 'l1', variantId: 'a', quantityOrdered: 10, quantityReceived: 4, unitCost: new Decimal('2.5') },
    { id: 'l2', variantId: 'b', quantityOrdered: 3, quantityReceived: 0, unitCost: new Decimal('7') },
  ];

  it('plans units up to what is outstanding on each line', () => {
    const plan = receiptPlan(S.PARTIALLY_RECEIVED, ordered, [
      { variantId: 'a', quantity: 6 },
      { variantId: 'b', quantity: 1 },
    ]);

    expect(plan).toEqual({
      refusal: null,
      lines: [
        { line: ordered[0], quantity: 6 },
        { line: ordered[1], quantity: 1 },
      ],
    });
  });

  it('refuses over-receipt, with no tolerance', () => {
    expect(receiptPlan(S.SENT, ordered, [{ variantId: 'a', quantity: 7 }])).toEqual({
      refusal: 'INVALID',
      problem: 'Cannot receive 7 of variant "a": only 6 outstanding',
    });
  });

  it.each([S.DRAFT, S.RECEIVED, S.CLOSED, S.CANCELLED])('refuses a %s order by its status', (status) => {
    expect(receiptPlan(status, ordered, [{ variantId: 'a', quantity: 1 }])).toMatchObject({ refusal: 'STATUS' });
  });

  it.each([
    ['no lines', []],
    [
      'a variant twice',
      [
        { variantId: 'a', quantity: 1 },
        { variantId: 'a', quantity: 1 },
      ],
    ],
    ['a variant not ordered', [{ variantId: 'z', quantity: 1 }]],
    ['zero units', [{ variantId: 'a', quantity: 0 }]],
  ])('refuses %s', (_case, arriving) => {
    expect(receiptPlan(S.SENT, ordered, arriving)).toMatchObject({ refusal: 'INVALID' });
  });
});
