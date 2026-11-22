import { Prisma } from '../generated/prisma/client';
import { OrderTaxSnapshot, refundPartsTax, refundTax } from './refund-tax';

const d = (value: string) => new Prisma.Decimal(value);
const order = (overrides: Partial<OrderTaxSnapshot> = {}): OrderTaxSnapshot => ({
  pricingVersion: 1,
  grandTotal: d('247.00'),
  taxLineAmounts: [d('30.00'), d('5.00'), d('5.00'), d('2.00')],
  refundedTax: [],
  ...overrides,
});

describe('refundTax', () => {
  it('returns the whole stored tax for a full refund', () => {
    expect(refundTax(d('247.00'), order())?.toFixed(2)).toBe('42.00');
  });

  it('takes the stored tax in proportion to the share refunded, half-up to the pesewa', () => {
    // 42 x 100 / 247 = 17.0040...
    expect(refundTax(d('100.00'), order())?.toFixed(2)).toBe('17.00');
    // 42 x 123.50 / 247 = 21.00
    expect(refundTax(d('123.50'), order())?.toFixed(2)).toBe('21.00');
  });

  it('never refunds more tax than was stored, over several refunds', () => {
    expect(refundTax(d('247.00'), order({ refundedTax: [d('17.00')] }))?.toFixed(2)).toBe('25.00');
    expect(refundTax(d('10.00'), order({ refundedTax: [d('42.00')] }))?.toFixed(2)).toBe('0.00');
  });

  it('reads only the stored lines: no stored tax means none refunded', () => {
    expect(refundTax(d('50.00'), order({ taxLineAmounts: [] }))?.toFixed(2)).toBe('0.00');
  });

  it('has no answer for an order placed before tax was recorded', () => {
    expect(refundTax(d('50.00'), order({ pricingVersion: 0, taxLineAmounts: [] }))).toBeNull();
  });
});

describe('refundPartsTax', () => {
  // A line of 3 units whose stored tax is 30.00 + 5.00 (35.00 for all units).
  const line = (refundedQuantity: number, quantity: number) => ({
    lineQuantity: 3,
    taxLineAmounts: [d('30.00'), d('5.00')],
    refundedQuantity,
    quantity,
  });

  it("takes each refunded unit's stored tax, the units of a line adding up to exactly its stored tax", () => {
    const taxes = [line(0, 1), line(1, 1), line(2, 1)].map((part) =>
      refundPartsTax({ lines: [part], amount: d('0') }, order())?.toFixed(2),
    );

    // 35 x 1/3 = 11.67, 35 x 2/3 = 23.33 → 11.66, then 35 - 23.33 = 11.67
    expect(taxes).toEqual(['11.67', '11.66', '11.67']);
  });

  it('adds the proportional tax of a free amount to the line tax', () => {
    const tax = refundPartsTax({ lines: [line(0, 3)], amount: d('100.00') }, order());

    // 35.00 + 42 x 100 / 247 (17.00)
    expect(tax?.toFixed(2)).toBe('42.00');
  });

  it('caps the total at the stored tax not yet refunded', () => {
    const tax = refundPartsTax({ lines: [line(0, 3)], amount: d('0') }, order({ refundedTax: [d('20.00')] }));

    expect(tax?.toFixed(2)).toBe('22.00');
  });

  it('adds nothing for the untaxed shipping fee and has no answer for legacy orders', () => {
    expect(refundPartsTax({ lines: [], amount: d('0') }, order())?.toFixed(2)).toBe('0.00');
    expect(refundPartsTax({ lines: [line(0, 1)], amount: d('0') }, order({ pricingVersion: 0 }))).toBeNull();
  });
});
