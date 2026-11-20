import { Prisma } from '../generated/prisma/client';
import { bestUnitPrice, CandidateDiscount, priceCart } from './pricing';

const pct = (id: string, value: number, minimumPurchase?: number): CandidateDiscount => ({
  id,
  type: 'PERCENTAGE',
  value,
  minimumPurchase,
});
const flat = (id: string, value: number, minimumPurchase?: number): CandidateDiscount => ({
  id,
  type: 'FLAT',
  value,
  minimumPurchase,
});
const money = (value: Prisma.Decimal) => value.toFixed(2);

describe('bestUnitPrice', () => {
  it.each([
    ['30% beats GHS 50 off on GHS 1,000', 1000, [flat('flat50', 50), pct('pct30', 30)], 'pct30', '300.00'],
    ['GHS 8 off beats 10% on GHS 50', 50, [pct('pct10', 10), flat('flat8', 8)], 'flat8', '8.00'],
    ['the larger of two percentages', 100, [pct('d1', 10), pct('d2', 20)], 'd2', '20.00'],
    ['equal savings keep the earlier candidate', 100, [flat('flat20', 20), pct('pct20', 20)], 'flat20', '20.00'],
  ])('picks the discount that saves the most money: %s', (_case, price, discounts, discountId, saving) => {
    const unit = bestUnitPrice(price, discounts);

    expect(unit.discountId).toBe(discountId);
    expect(money(unit.unitDiscount)).toBe(saving);
    expect(money(unit.discountedUnitPrice)).toBe(money(new Prisma.Decimal(price).sub(saving)));
  });

  it('returns the list price when no discount applies', () => {
    const unit = bestUnitPrice(new Prisma.Decimal('19.99'), []);

    expect(unit).toEqual({
      unitPrice: new Prisma.Decimal('19.99'),
      unitDiscount: new Prisma.Decimal(0),
      discountedUnitPrice: new Prisma.Decimal('19.99'),
    });
  });

  it('never takes off more than the price', () => {
    const unit = bestUnitPrice(100, [flat('flat200', 200)]);

    expect(money(unit.unitDiscount)).toBe('100.00');
    expect(money(unit.discountedUnitPrice)).toBe('0.00');
  });

  it('rounds the unit discount half-up to the pesewa', () => {
    const unit = bestUnitPrice('19.99', [pct('pct15', 15)]);

    expect(money(unit.unitDiscount)).toBe('3.00');
    expect(money(unit.discountedUnitPrice)).toBe('16.99');
  });
});

describe('priceCart', () => {
  it('totals the lines from the rounded unit prices, so lines add up to the cart total', () => {
    const priced = priceCart(
      [
        { variantId: 'v1', productId: 'p1', unitPrice: '19.99', quantity: 3 },
        { variantId: 'v2', productId: 'p2', unitPrice: '10.00', quantity: 1 },
      ],
      new Map([['v1', [pct('pct15', 15)]]]),
    );

    expect(priced.lines.map((line) => [line.variantId, money(line.lineDiscount), money(line.lineTotal)])).toEqual([
      ['v1', '9.00', '50.97'],
      ['v2', '0.00', '10.00'],
    ]);
    expect(money(priced.grossSubtotal)).toBe('69.97');
    expect(money(priced.discountTotal)).toBe('9.00');
    expect(money(priced.subtotal)).toBe('60.97');
  });

  it('skips a discount whose minimum purchase the list-price subtotal does not reach', () => {
    const lines = [{ variantId: 'v1', productId: 'p1', unitPrice: 100, quantity: 2 }];

    const below = priceCart(lines, new Map([['v1', [pct('big', 50, 300), pct('small', 10)]]]));
    const reached = priceCart(lines, new Map([['v1', [pct('big', 50, 200), pct('small', 10)]]]));

    expect(below.lines[0].discountId).toBe('small');
    expect(money(below.subtotal)).toBe('180.00');
    expect(reached.lines[0].discountId).toBe('big');
    expect(money(reached.subtotal)).toBe('100.00');
  });

  it('keys discounts per variant, so two variants of one product can be priced differently', () => {
    const priced = priceCart(
      [
        { variantId: 'small', productId: 'p1', unitPrice: 100, quantity: 1 },
        { variantId: 'large', productId: 'p1', unitPrice: 120, quantity: 1 },
      ],
      new Map([
        ['small', [pct('product10', 10)]],
        ['large', [pct('product10', 10), flat('large30', 30)]],
      ]),
    );

    expect(
      priced.lines.map((line) => [line.variantId, line.productId, line.discountId, money(line.lineTotal)]),
    ).toEqual([
      ['small', 'p1', 'product10', '90.00'],
      ['large', 'p1', 'large30', '90.00'],
    ]);
    expect(money(priced.subtotal)).toBe('180.00');
  });

  it('applies no discount to a variant missing from the map', () => {
    const priced = priceCart(
      [{ variantId: 'v2', productId: 'p1', unitPrice: 50, quantity: 2 }],
      new Map([['v1', [pct('pct50', 50)]]]),
    );

    expect(priced.lines[0].discountId).toBeUndefined();
    expect(money(priced.subtotal)).toBe('100.00');
  });
});
