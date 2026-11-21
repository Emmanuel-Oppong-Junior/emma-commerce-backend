import { Decimal } from '@prisma/client/runtime/client';
import { toMinorUnits } from '../commons/money/money';
import {
  bestUnitPromotion,
  CouponNotApplicableError,
  price as enginePrice,
  PRICING_VERSION,
  PricingCart,
  PricingContext,
  PricingCouponCode,
  PricingLine,
  PricingPromotion,
  PricingTaxRate,
  Quote,
} from './price';

const d = (value: Decimal.Value) => new Decimal(value);
const sum = (values: Decimal[]) => values.reduce((total, value) => total.add(value), d(0));
const money = (value: Decimal) => value.toFixed(2);

const NOW = new Date('2026-11-21T12:00:00.000Z');
const YESTERDAY = new Date('2026-11-20T12:00:00.000Z');
const TOMORROW = new Date('2026-11-22T12:00:00.000Z');

const line = (overrides: Partial<PricingLine> = {}): PricingLine => ({
  variantId: 'v1',
  productId: 'p1',
  categoryId: 'c1',
  brandId: null,
  quantity: 1,
  unitListPrice: d('121.00'),
  taxable: false,
  ...overrides,
});

const promotion = (
  id: string,
  type: PricingPromotion['type'],
  value: Decimal.Value,
  overrides: Partial<PricingPromotion> = {},
): PricingPromotion => ({
  id,
  name: id,
  description: null,
  scope: 'PRODUCT',
  type,
  value: d(value),
  minimumSpend: null,
  minimumQuantity: null,
  startsAt: YESTERDAY,
  endsAt: TOMORROW,
  isActive: true,
  priority: 0,
  stackingGroup: 'default',
  exclusive: false,
  requiresCoupon: false,
  usageLimit: null,
  usedCount: 0,
  perCustomerLimit: null,
  createdAt: YESTERDAY,
  targetIds: ['p1'],
  ...overrides,
});
const pct = (id: string, value: Decimal.Value, overrides: Partial<PricingPromotion> = {}) =>
  promotion(id, 'PERCENT', value, overrides);
const flat = (id: string, value: Decimal.Value, overrides: Partial<PricingPromotion> = {}) =>
  promotion(id, 'AMOUNT_OFF', value, overrides);

/** A cart promotion a coupon code unlocks (a legacy coupon: CART scope, AMOUNT_OFF 10 by default). */
const coupon = (overrides: Partial<PricingPromotion> = {}): PricingPromotion =>
  promotion('cpn1', 'AMOUNT_OFF', 10, {
    scope: 'CART',
    targetIds: [],
    requiresCoupon: true,
    endsAt: null,
    ...overrides,
  });
const couponCode = (overrides: Partial<PricingCouponCode> = {}): PricingCouponCode => ({
  id: 'code1',
  code: 'SAVE',
  promotionId: 'cpn1',
  isActive: true,
  usageLimit: null,
  usedCount: 0,
  ...overrides,
});

const VAT: PricingTaxRate = { id: 'vat', name: 'VAT', rate: d('0.15') };
const NHIL: PricingTaxRate = { id: 'nhil', name: 'NHIL', rate: d('0.025') };
const GETFUND: PricingTaxRate = { id: 'getfund', name: 'GETFund', rate: d('0.025') };
const COVID: PricingTaxRate = { id: 'covid', name: 'COVID-19', rate: d('0.01') };
const GHANA = [VAT, NHIL, GETFUND, COVID];

const context = (overrides: Partial<PricingContext> = {}): PricingContext => ({
  currency: 'GHS',
  now: NOW,
  promotions: [],
  taxRates: [],
  customer: { redemptions: {} },
  ...overrides,
});

/** A cart with, optionally, the coupon promotion its code (couponCode(), unless given) unlocks. */
interface TestCart extends PricingCart {
  coupon?: PricingPromotion;
}
const cart = (lines: PricingLine[], overrides: Partial<TestCart> = {}): TestCart => ({
  lines,
  shippingFee: d(0),
  ...overrides,
});

/** Prices a test cart: its coupon promotion joins the candidates and its code goes in the cart. */
function price({ coupon: unlocked, ...pricingCart }: TestCart, pricingContext: PricingContext): Quote {
  if (!unlocked) return enginePrice(pricingCart, pricingContext);
  return enginePrice(
    { ...pricingCart, couponCode: pricingCart.couponCode ?? couponCode({ promotionId: unlocked.id }) },
    { ...pricingContext, promotions: [...pricingContext.promotions, unlocked] },
  );
}

/** Deterministic pseudo-random integers, so the property loop is reproducible from its seed. */
function sequence(seed: number) {
  let state = seed;
  return (maxExclusive: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % maxExclusive;
  };
}

function shuffled<T>(items: readonly T[], next: (max: number) => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = next(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** Exact equality of amounts, treating -0 and 0 as the same. */
function expectSame(actual: Decimal, expected: Decimal) {
  expect(actual.sub(expected).isZero() ? 'equal' : `${actual.toString()} != ${expected.toString()}`).toBe('equal');
}

function expectBalanced(quote: Quote) {
  const lineNets = sum(quote.lines.map((l) => l.unitNet.mul(l.quantity)));
  const orderAdjustments = sum(quote.adjustments.map((a) => a.amount));
  const allAdjustments = sum([...quote.lines.flatMap((l) => l.adjustments), ...quote.adjustments].map((a) => a.amount));

  expectSame(lineNets.add(orderAdjustments).add(quote.taxTotal).add(quote.shippingTotal), quote.grandTotal);
  expectSame(quote.subtotal.sub(quote.discountTotal).add(quote.shippingTotal), quote.grandTotal);
  expectSame(allAdjustments.neg(), quote.discountTotal);
  expectSame(sum(quote.lines.map((l) => l.unitTax.mul(l.quantity))), quote.taxTotal);
  for (const adjustment of quote.adjustments) {
    expect(adjustment.allocations).toHaveLength(quote.lines.length);
    expectSame(sum(adjustment.allocations), adjustment.amount);
  }
  quote.lines.forEach((l, index) => {
    expectSame(l.unitNet.add(l.unitTax), l.unitListPrice.sub(l.unitDiscount));
    expectSame(l.unitNet.add(l.unitTax).mul(l.quantity), l.lineTotal);
    expectSame(sum(l.taxLines.map((t) => t.amount)), l.unitTax.mul(l.quantity));
    expectSame(sum(l.adjustments.map((a) => a.amount)), l.unitDiscount.mul(l.quantity).neg());
    const share = sum(quote.adjustments.map((a) => a.allocations[index]));
    // Never negative: no line, and no line after its share of the coupon, goes below zero.
    for (const value of [l.unitNet, l.unitTax, l.unitDiscount, l.lineTotal.add(share)]) {
      expect(value.isNegative() && !value.isZero()).toBe(false);
    }
  });
  // The charged amount is exactly the grand total, in whole pesewas.
  expectSame(d(toMinorUnits(quote.grandTotal)).div(100), quote.grandTotal);
  expect(quote.grandTotal.isNegative()).toBe(false);
}

describe('price', () => {
  describe('item discounts', () => {
    it.each([
      ['30% beats GHS 50 off on GHS 1,000', '1000', [flat('flat50', 50), pct('pct30', 30)], 'pct30', '300.00'],
      ['GHS 8 off beats 10% on GHS 50', '50', [pct('pct10', 10), flat('flat8', 8)], 'flat8', '8.00'],
      ['the larger of two percentages', '100', [pct('d1', 10), pct('d2', 20)], 'd2', '20.00'],
    ])('takes the discount that saves the most money: %s', (_case, unit, discounts, discountId, saving) => {
      const quote = price(cart([line({ unitListPrice: d(unit) })]), context({ promotions: discounts }));

      expect(quote.lines[0].adjustments).toEqual([
        { type: 'DISCOUNT', sourceId: discountId, code: null, amount: d(saving).neg() },
      ]);
      expect(money(quote.lines[0].unitDiscount)).toBe(saving);
    });

    it('gives equal savings to the oldest discount, then the lowest id, whatever order they come in', () => {
      const older = flat('zz-older', 20, { createdAt: new Date('2026-01-01') });
      const newer = pct('aa-newer', 20, { createdAt: new Date('2026-02-01') });
      const sameAgeA = flat('a-same', 20);
      const sameAgeB = pct('b-same', 20);

      for (const discounts of [
        [older, newer],
        [newer, older],
      ]) {
        expect(bestUnitPromotion(d(100), discounts).promotion?.id).toBe('zz-older');
      }
      expect(bestUnitPromotion(d(100), [sameAgeB, sameAgeA]).promotion?.id).toBe('a-same');
    });

    it('returns the list price when no discount applies', () => {
      const quote = price(cart([line({ unitListPrice: d('19.99') })]), context());

      expect(quote.lines[0]).toMatchObject({ unitDiscount: d(0), lineTotal: d('19.99'), adjustments: [] });
    });

    it('never takes off more than the price: a 100% or oversized discount makes the line free', () => {
      const flatQuote = price(cart([line({ unitListPrice: d(100) })]), context({ promotions: [flat('f200', 200)] }));
      const fullQuote = price(cart([line({ unitListPrice: d(100) })]), context({ promotions: [pct('p100', 100)] }));

      for (const quote of [flatQuote, fullQuote]) {
        expect(quote.lines[0]).toMatchObject({ unitDiscount: d(100), lineTotal: d(0) });
        expect(quote.grandTotal).toEqual(d(0));
        expectBalanced(quote);
      }
    });

    it('rounds the unit discount half-up to the pesewa and totals lines from the rounded unit prices', () => {
      const quote = price(
        cart([
          line({ variantId: 'v1', unitListPrice: d('19.99'), quantity: 3 }),
          line({ variantId: 'v2', productId: 'p2', unitListPrice: d('10.00') }),
        ]),
        context({ promotions: [pct('pct15', 15)] }),
      );

      expect(quote.lines.map((l) => [l.variantId, money(l.unitDiscount), money(l.lineTotal)])).toEqual([
        ['v1', '3.00', '50.97'],
        ['v2', '0.00', '10.00'],
      ]);
      expect([quote.subtotal, quote.discountTotal, quote.grandTotal].map(money)).toEqual(['69.97', '9.00', '60.97']);
    });

    it('applies a discount on the variant, its product or its category, and nothing else', () => {
      const lines = [
        line({ variantId: 'small', productId: 'p1', categoryId: null, unitListPrice: d(100) }),
        line({ variantId: 'large', productId: 'p1', categoryId: null, unitListPrice: d(120) }),
        line({ variantId: 'cap', productId: 'p2', categoryId: 'hats', unitListPrice: d(50) }),
        line({ variantId: 'sock', productId: 'p3', categoryId: 'socks', unitListPrice: d(10) }),
      ];
      const discounts = [
        pct('product10', 10),
        flat('large30', 30, { scope: 'SKU', targetIds: ['large'] }),
        pct('hats50', 50, { scope: 'CATEGORY', targetIds: ['hats'] }),
      ];

      const quote = price(cart(lines), context({ promotions: discounts }));

      expect(quote.lines.map((l) => [l.variantId, l.adjustments[0]?.sourceId ?? null, money(l.lineTotal)])).toEqual([
        ['small', 'product10', '90.00'],
        ['large', 'large30', '90.00'],
        ['cap', 'hats50', '25.00'],
        ['sock', null, '10.00'],
      ]);
    });

    it('ignores discounts that are inactive or outside their dates at `now`', () => {
      const discounts = [
        pct('off', 50, { isActive: false }),
        pct('future', 40, { startsAt: TOMORROW, endsAt: TOMORROW }),
        pct('past', 30, { startsAt: YESTERDAY, endsAt: new Date(NOW.getTime() - 1) }),
        pct('current', 5),
      ];

      const quote = price(cart([line({ unitListPrice: d(100) })]), context({ promotions: discounts }));

      expect(quote.lines[0].adjustments[0].sourceId).toBe('current');
    });

    it('skips a discount whose minimum purchase the list-price subtotal does not reach', () => {
      const lines = [line({ unitListPrice: d(100), quantity: 2 })];
      const discounts = (minimum: number) => [pct('big', 50, { minimumSpend: d(minimum) }), pct('small', 10)];

      const below = price(cart(lines), context({ promotions: discounts(300) }));
      const reached = price(cart(lines), context({ promotions: discounts(200) }));

      expect(below.lines[0].adjustments[0].sourceId).toBe('small');
      expect(money(below.grandTotal)).toBe('180.00');
      expect(reached.lines[0].adjustments[0].sourceId).toBe('big');
      expect(money(reached.grandTotal)).toBe('100.00');
    });
  });

  describe('tax', () => {
    it('splits a tax-inclusive price into its net and the tax in it, one tax line per active tax', () => {
      const quote = price(cart([line({ taxable: true, quantity: 2 })]), context({ taxRates: GHANA }));

      const [l] = quote.lines;
      expect([l.unitNet, l.unitTax, l.lineTotal]).toEqual([d(100), d(21), d(242)]);
      expect(l.taxLines.map((t) => [t.taxId, t.rate.toString(), t.base.toString(), t.amount.toString()])).toEqual([
        ['covid', '0.01', '200', '2'],
        ['getfund', '0.025', '200', '5'],
        ['nhil', '0.025', '200', '5'],
        ['vat', '0.15', '200', '30'],
      ]);
      expect(quote).toMatchObject({ pricingVersion: PRICING_VERSION, taxTotal: d(42), grandTotal: d(242) });
    });

    it('takes the tax out of the discounted price', () => {
      const quote = price(
        cart([line({ taxable: true, quantity: 3 })]),
        context({ taxRates: [VAT], promotions: [pct('disc10', 10)] }),
      );

      const [l] = quote.lines;
      expect([l.unitDiscount, l.unitNet, l.unitTax, l.lineTotal].map((v) => v.toString())).toEqual([
        '12.1',
        '94.7',
        '14.2',
        '326.7',
      ]);
      expect(l.adjustments).toEqual([{ type: 'DISCOUNT', sourceId: 'disc10', code: null, amount: d('-36.3') }]);
      expect([quote.subtotal, quote.discountTotal, quote.grandTotal]).toEqual([d('363'), d('36.3'), d('326.7')]);
    });

    it('splits a remainder pesewa between equal rates the same way whatever order the taxes come in', () => {
      const taxable = cart([line({ taxable: true, unitListPrice: d('100.01') })]);

      const forward = price(taxable, context({ taxRates: [NHIL, GETFUND] }));
      const backward = price(taxable, context({ taxRates: [GETFUND, NHIL] }));

      expect(forward.lines[0].taxLines).toEqual(backward.lines[0].taxLines);
      expect(forward.quoteHash).toBe(backward.quoteHash);
      expectSame(sum(forward.lines[0].taxLines.map((t) => t.amount)), forward.lines[0].unitTax);
    });

    it('puts no tax on a line whose price had no tax added, nor on any line when no tax is active', () => {
      const untaxed = price(cart([line({ taxable: false })]), context({ taxRates: GHANA }));
      const noTaxes = price(cart([line({ taxable: true })]), context());
      const zeroRate = price(
        cart([line({ taxable: true })]),
        context({ taxRates: [{ id: 'z', name: 'Zero', rate: d(0) }] }),
      );

      for (const quote of [untaxed, noTaxes, zeroRate]) {
        expect(quote.lines[0]).toMatchObject({ unitNet: d('121'), unitTax: d(0), taxLines: [] });
        expect(quote.taxTotal).toEqual(d(0));
      }
    });

    it('refuses a negative tax rate', () => {
      expect(() => price(cart([line()]), context({ taxRates: [{ ...VAT, rate: d('-0.1') }] }))).toThrow(RangeError);
    });
  });

  describe('coupon', () => {
    it('comes off the discounted subtotal as an order adjustment, untaxed, before shipping', () => {
      const quote = price(
        cart([line({ unitListPrice: d(100), quantity: 2 })], {
          coupon: coupon({ type: 'PERCENT', value: d(10) }),
          shippingFee: d(5),
        }),
        context({ promotions: [flat('d', 10)] }),
      );

      expect(quote.adjustments).toEqual([
        { type: 'COUPON', sourceId: 'cpn1', code: 'SAVE', amount: d('-18'), allocations: [d('-18')] },
      ]);
      expect(quote).toMatchObject({
        subtotal: d(200),
        discountTotal: d(38),
        taxTotal: d(0),
        shippingTotal: d(5),
        grandTotal: d(167),
      });
    });

    it('is allocated to the lines by largest remainder, so the shares add up exactly', () => {
      const quote = price(
        cart(
          [
            line({ variantId: 'a', unitListPrice: d(10) }),
            line({ variantId: 'b', unitListPrice: d(10) }),
            line({ variantId: 'c', unitListPrice: d(10) }),
          ],
          { coupon: coupon({ value: d(10) }) },
        ),
        context(),
      );

      expect(quote.adjustments[0].allocations.map(money)).toEqual(['-3.34', '-3.33', '-3.33']);
      expectBalanced(quote);
    });

    it('gives the remainder pesewa to the same line whatever order the cart lines come in', () => {
      const lines = [
        line({ variantId: 'a', unitListPrice: d(10) }),
        line({ variantId: 'b', unitListPrice: d(10) }),
        line({ variantId: 'c', unitListPrice: d(10) }),
      ];
      const reversed = [...lines].reverse();

      const forward = price(cart(lines, { coupon: coupon() }), context());
      const backward = price(cart(reversed, { coupon: coupon() }), context());

      const shareOf = (quote: Quote, variantId: string) =>
        money(quote.adjustments[0].allocations[quote.lines.findIndex((l) => l.variantId === variantId)]);
      expect(['a', 'b', 'c'].map((v) => shareOf(backward, v))).toEqual(['a', 'b', 'c'].map((v) => shareOf(forward, v)));
      expect(backward.lines.map((l) => l.variantId)).toEqual(['c', 'b', 'a']);
      expect(backward.quoteHash).toBe(forward.quoteHash);
    });

    it('never takes more than the discounted subtotal, so lines and shipping stay charged', () => {
      const flatQuote = price(
        cart([line({ unitListPrice: d(10) })], { coupon: coupon({ value: d(50) }), shippingFee: d(5) }),
        context(),
      );
      const oversizedPercentage = price(
        cart([line({ unitListPrice: d(10) })], {
          coupon: coupon({ type: 'PERCENT', value: d(150) }),
          shippingFee: d(5),
        }),
        context(),
      );

      for (const quote of [flatQuote, oversizedPercentage]) {
        expect(quote.adjustments[0].amount).toEqual(d(-10));
        expect(quote.grandTotal).toEqual(d(5));
        expectBalanced(quote);
      }
    });

    it('records no adjustment for a coupon worth nothing, such as on a cart made free by its discounts', () => {
      const zero = price(cart([line()], { coupon: coupon({ value: d(0) }) }), context());
      const freeCart = price(cart([line()], { coupon: coupon() }), context({ promotions: [pct('all', 100)] }));

      expect(zero.adjustments).toEqual([]);
      expect(freeCart.adjustments).toEqual([]);
      expect(freeCart.grandTotal).toEqual(d(0));
    });

    it.each([
      ['inactive', coupon({ isActive: false }), 'This coupon is no longer active', undefined],
      ['expired', coupon({ endsAt: new Date(NOW.getTime() - 1) }), 'This coupon has expired', undefined],
      ['used up', coupon({ usageLimit: 3, usedCount: 3 }), 'This coupon has reached its usage limit', undefined],
      [
        'below its minimum after item discounts',
        coupon({ minimumSpend: d(100) }),
        'Order total must be at least 100 to use this coupon',
        undefined,
      ],
      ['already used by the customer', coupon({ perCustomerLimit: 1 }), 'You have already used this coupon', undefined],
      ['code deactivated', coupon(), 'This coupon is no longer active', couponCode({ isActive: false })],
      [
        'code used up',
        coupon(),
        'This coupon has reached its usage limit',
        couponCode({ usageLimit: 2, usedCount: 2 }),
      ],
      ['not started yet', coupon({ startsAt: TOMORROW }), 'This coupon is not active yet', undefined],
    ])('refuses a coupon that is %s', (_case, refused, message, code: PricingCouponCode | undefined) => {
      // GHS 110 list, 10% off: the coupon's minimum is checked against the discounted 99. The customer has used
      // cpn1 once before (only a per-customer limit of 1 refuses it).
      const run = () =>
        price(
          cart([line({ unitListPrice: d(110) })], { coupon: refused, couponCode: code }),
          context({ promotions: [pct('d10', 10)], customer: { redemptions: { cpn1: 1 } } }),
        );

      expect(run).toThrow(CouponNotApplicableError);
      expect(run).toThrow(message);
    });

    it('accepts a coupon expiring exactly now and one with uses left', () => {
      const quote = price(
        cart([line({ unitListPrice: d(50) })], { coupon: coupon({ endsAt: NOW, usageLimit: 3, usedCount: 2 }) }),
        context(),
      );

      expect(quote.adjustments[0].amount).toEqual(d(-10));
    });

    it('refuses a code whose item promotion targets nothing in the cart', () => {
      const run = () =>
        price(cart([line()], { coupon: coupon({ scope: 'PRODUCT', targetIds: ['other'] }) }), context());

      expect(run).toThrow('This coupon does not apply to any item in your cart');
    });
  });

  describe('shipping', () => {
    it('adds the delivery fee untaxed, and nothing for pickup', () => {
      const delivery = price(cart([line({ taxable: true })], { shippingFee: d(15) }), context({ taxRates: [VAT] }));
      const pickup = price(cart([line({ taxable: true })]), context({ taxRates: [VAT] }));

      expect(delivery.grandTotal.sub(pickup.grandTotal)).toEqual(d(15));
      expect(delivery.taxTotal).toEqual(pickup.taxTotal);
      expect(delivery.shippingTotal).toEqual(d(15));
      expect(pickup.shippingTotal).toEqual(d(0));
      expect(delivery.quoteHash).not.toBe(pickup.quoteHash);
    });

    it('refuses a negative fee or one in fractions of a pesewa', () => {
      expect(() => price(cart([line()], { shippingFee: d(-1) }), context())).toThrow(RangeError);
      expect(() => price(cart([line()], { shippingFee: d('1.005') }), context())).toThrow(RangeError);
    });
  });

  describe('carts', () => {
    it('prices an empty cart at zero', () => {
      const quote = price(cart([]), context());

      expect(quote).toMatchObject({ lines: [], adjustments: [], subtotal: d(0), grandTotal: d(0) });
    });

    it.each([
      ['a quantity that is not a positive whole number', line({ quantity: 0 })],
      ['a fractional quantity', line({ quantity: 1.5 })],
      ['a negative price', line({ unitListPrice: d('-1') })],
      ['a price in fractions of a pesewa', line({ unitListPrice: d('1.005') })],
    ])('refuses %s', (_case, bad) => {
      expect(() => price(cart([bad]), context({ taxRates: GHANA }))).toThrow(RangeError);
    });

    it('prices in the currency it is given', () => {
      expect(price(cart([line()]), context({ currency: 'USD' })).currency).toBe('USD');
    });
  });

  describe('quote hash', () => {
    const lines = [
      line({ variantId: 'v1', unitListPrice: d('117.50'), quantity: 2, taxable: true }),
      line({ variantId: 'v2', productId: 'p2', unitListPrice: d('499.99') }),
    ];
    const full = (overrides: Partial<TestCart> = {}, contextOverrides: Partial<PricingContext> = {}) =>
      price(
        cart(lines, { coupon: coupon({ value: d(20) }), shippingFee: d(15), ...overrides }),
        context({ taxRates: [VAT, NHIL], promotions: [pct('disc10', 10)], ...contextOverrides }),
      );

    it('is a SHA-256 hex digest, the same for the same input', () => {
      expect(full().quoteHash).toMatch(/^[0-9a-f]{64}$/);
      expect(full().quoteHash).toBe(full().quoteHash);
    });

    it('does not depend on the order of lines, discounts or taxes, nor on ids that do not change the amount', () => {
      const base = full();

      const reordered = price(
        cart([...lines].reverse(), { coupon: coupon({ value: d(20) }), shippingFee: d(15) }),
        context({ taxRates: [NHIL, VAT], promotions: [flat('unused', 0), pct('disc10', 10)] }),
      );
      const otherIds = price(
        cart(
          lines.map((l) => ({ ...l, productId: `${l.productId}-x`, categoryId: 'other' })),
          { coupon: coupon({ value: d(20) }), shippingFee: d(15) },
        ),
        context({
          taxRates: [
            { ...VAT, id: 'vat-2' },
            { ...NHIL, id: 'nhil-2' },
          ],
          promotions: [pct('disc10', 10, { targetIds: ['p1-x'] })],
          now: TOMORROW,
        }),
      );

      expect(reordered.quoteHash).toBe(base.quoteHash);
      expect(otherIds.quoteHash).toBe(base.quoteHash);
    });

    it.each([
      ['a price', () => full({ lines: [{ ...lines[0], unitListPrice: d('117.60') }, lines[1]] })],
      ['a quantity', () => full({ lines: [{ ...lines[0], quantity: 3 }, lines[1]] })],
      ['the discount taken', () => full({}, { promotions: [pct('disc11', 10)] })],
      ['a discount value', () => full({}, { promotions: [pct('disc10', 11)] })],
      ['a tax rate', () => full({}, { taxRates: [{ ...VAT, rate: d('0.16') }, NHIL] })],
      ['a tax name', () => full({}, { taxRates: [{ ...VAT, name: 'VAT-2' }, NHIL] })],
      ['the coupon value', () => full({ coupon: coupon({ value: d(21) }) })],
      ['the coupon code', () => full({ coupon: coupon({ value: d(20) }), couponCode: couponCode({ code: 'OTHER' }) })],
      ['no coupon', () => full({ coupon: undefined })],
      ['the shipping fee', () => full({ shippingFee: d(16) })],
      ['the currency', () => full({}, { currency: 'USD' })],
    ])('changes with %s', (_case, changed) => {
      expect(changed().quoteHash).not.toBe(full().quoteHash);
    });
  });

  describe('property: Σ line nets + adjustments + tax + shipping = grand total = the amount charged', () => {
    const seeds = [1, 7, 42, 2026, 31337];
    const taxSets = [[], [VAT], GHANA, [{ id: 'odd', name: 'Odd', rate: d('0.0333') }, NHIL]];

    it.each(seeds)(
      'holds, deterministically and whatever the input order, for 300 random carts from seed %i',
      (seed) => {
        const next = sequence(seed);
        const pesewas = (max: number) => d(next(max)).div(100);

        for (let run = 0; run < 300; run += 1) {
          const lines = Array.from({ length: next(7) }, (_, index) =>
            line({
              variantId: `v${next(4)}${index}`,
              productId: `p${next(3)}`,
              categoryId: next(3) === 0 ? null : `c${next(2)}`,
              quantity: 1 + next(12),
              unitListPrice: pesewas(500_000),
              taxable: next(4) !== 0,
            }),
          );
          const discounts = Array.from({ length: next(4) }, (_, index) =>
            next(2) === 0
              ? pct(`pct${index}`, next(101), {
                  targetIds: [`p${next(3)}`],
                  minimumSpend: next(3) === 0 ? pesewas(1_000_000) : null,
                  createdAt: new Date(2026, 0, 1 + next(3)),
                })
              : flat(`flat${index}`, pesewas(600_000), {
                  scope: 'CATEGORY',
                  targetIds: [`c${next(2)}`],
                  createdAt: new Date(2026, 0, 1 + next(3)),
                }),
          );
          const randomCoupon =
            next(2) === 0
              ? coupon({
                  type: next(2) === 0 ? 'AMOUNT_OFF' : 'PERCENT',
                  value: next(2) === 0 ? pesewas(300_000) : d(next(160)),
                })
              : undefined;
          const taxRates = taxSets[next(taxSets.length)];
          const shippingFee = pesewas(10_000);

          const quote = price(
            cart(lines, { coupon: randomCoupon, shippingFee }),
            context({ promotions: discounts, taxRates }),
          );
          const again = price(
            cart(shuffled(lines, next), { coupon: randomCoupon, shippingFee }),
            context({ promotions: shuffled(discounts, next), taxRates: shuffled(taxRates, next) }),
          );

          expectBalanced(quote);
          expect(again.quoteHash).toBe(quote.quoteHash);
          expect(money(again.grandTotal)).toBe(money(quote.grandTotal));
        }
      },
    );
  });
});
