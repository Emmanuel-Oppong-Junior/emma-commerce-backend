import { Prisma } from '../generated/prisma/client';
import { sellingPrice, taxInclusivePrice } from './tax-inclusive-price';

describe('taxInclusivePrice', () => {
  it.each([
    ['10.10', '0.15', '11.62'],
    ['0.10', '0.15', '0.12'],
    ['1.30', '0.15', '1.50'],
    ['11.10', '0.15', '12.77'],
    ['100.00', '0.21', '121.00'],
    ['19.99', '0', '19.99'],
  ])('prices %s at rate %s as %s, rounding half away from zero like numeric ROUND', (base, rate, expected) => {
    expect(taxInclusivePrice(base, new Prisma.Decimal(rate)).toFixed(2)).toBe(expected);
  });
});

describe('sellingPrice', () => {
  it("adds tax to a taxable product's variant", () => {
    expect(sellingPrice('100.00', true, new Prisma.Decimal('0.2')).toFixed(2)).toBe('120.00');
  });

  it('is the base price, to the pesewa, when the product is not taxable', () => {
    expect(sellingPrice('99.5', false, new Prisma.Decimal('0.2')).toFixed(2)).toBe('99.50');
  });
});
