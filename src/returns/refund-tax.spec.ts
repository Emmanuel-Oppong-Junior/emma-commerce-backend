import { Prisma } from '../generated/prisma/client';
import { OrderTaxSnapshot, refundTax } from './refund-tax';

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
