import { Decimal } from '@prisma/client/runtime/client';
import { toMinorUnits } from '../commons/money/money';
import { OrderSnapshot, PricedOrderLine, PRICING_VERSION, snapshotOrder, TaxRateSnapshot } from './order-totals';

const d = (value: Decimal.Value) => new Decimal(value);
const sum = (values: Decimal[]) => values.reduce((total, value) => total.add(value), d(0));

const line = (overrides: Partial<PricedOrderLine> = {}): PricedOrderLine => ({
  productId: 'p1',
  variantId: 'v1',
  productName: 'Mug',
  sku: 'MUG',
  optionValues: {},
  quantity: 1,
  unitListPrice: d('121.00'),
  unitDiscount: d(0),
  taxable: true,
  ...overrides,
});

const VAT: TaxRateSnapshot = { taxId: 'vat', name: 'VAT', rate: d('0.15') };
const NHIL: TaxRateSnapshot = { taxId: 'nhil', name: 'NHIL', rate: d('0.025') };
const GETFUND: TaxRateSnapshot = { taxId: 'getfund', name: 'GETFund', rate: d('0.025') };
const COVID: TaxRateSnapshot = { taxId: 'covid', name: 'COVID-19', rate: d('0.01') };
const GHANA = [VAT, NHIL, GETFUND, COVID];

/** Deterministic pseudo-random integers, so the property loop is reproducible from its seed. */
function sequence(seed: number) {
  let state = seed;
  return (maxExclusive: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % maxExclusive;
  };
}

/** Exact equality of amounts, treating -0 and 0 as the same. */
function expectSame(actual: Decimal, expected: Decimal) {
  expect(actual.sub(expected).isZero() ? 'equal' : `${actual.toString()} != ${expected.toString()}`).toBe('equal');
}

function expectBalanced(snapshot: OrderSnapshot) {
  const lineNets = sum(snapshot.lines.map((l) => l.unitNet.mul(l.quantity)));
  const orderAdjustments = sum(snapshot.adjustments.map((a) => a.amount));
  const allAdjustments = sum(
    [...snapshot.lines.flatMap((l) => l.adjustments), ...snapshot.adjustments].map((a) => a.amount),
  );

  expectSame(lineNets.add(orderAdjustments).add(snapshot.taxTotal).add(snapshot.shippingTotal), snapshot.grandTotal);
  expectSame(snapshot.subtotal.sub(snapshot.discountTotal).add(snapshot.shippingTotal), snapshot.grandTotal);
  expectSame(allAdjustments.neg(), snapshot.discountTotal);
  expectSame(sum(snapshot.lines.map((l) => l.unitTax.mul(l.quantity))), snapshot.taxTotal);
  for (const l of snapshot.lines) {
    expectSame(l.unitNet.add(l.unitTax), l.unitListPrice.sub(l.unitDiscount));
    expectSame(l.unitNet.add(l.unitTax).mul(l.quantity), l.lineTotal);
    expectSame(sum(l.taxLines.map((t) => t.amount)), l.unitTax.mul(l.quantity));
    expectSame(sum(l.adjustments.map((a) => a.amount)), l.unitDiscount.mul(l.quantity).neg());
  }
  // The charged amount is exactly the grand total, in whole pesewas.
  expectSame(d(toMinorUnits(snapshot.grandTotal)).div(100), snapshot.grandTotal);
  expect(snapshot.grandTotal.isNegative()).toBe(false);
}

describe('snapshotOrder', () => {
  it('splits a tax-inclusive price into its net and the tax in it, one tax line per active tax', () => {
    const snapshot = snapshotOrder({ currency: 'GHS', lines: [line({ quantity: 2 })], taxes: GHANA, shipping: d(0) });

    const [l] = snapshot.lines;
    expect(l.unitNet).toEqual(d('100'));
    expect(l.unitTax).toEqual(d('21'));
    expect(l.lineTotal).toEqual(d('242'));
    expect(l.taxLines.map((t) => [t.taxId, t.rate.toString(), t.base.toString(), t.amount.toString()])).toEqual([
      ['vat', '0.15', '200', '30'],
      ['nhil', '0.025', '200', '5'],
      ['getfund', '0.025', '200', '5'],
      ['covid', '0.01', '200', '2'],
    ]);
    expect(snapshot).toMatchObject({ pricingVersion: PRICING_VERSION, taxTotal: d(42), grandTotal: d(242) });
  });

  it('takes the tax out of the discounted price, and records the product discount as a line adjustment', () => {
    const snapshot = snapshotOrder({
      currency: 'GHS',
      lines: [line({ unitListPrice: d('121.00'), unitDiscount: d('12.10'), discountId: 'disc10', quantity: 3 })],
      taxes: [VAT],
      shipping: d(0),
    });

    const [l] = snapshot.lines;
    expect([l.unitNet.toString(), l.unitTax.toString(), l.lineTotal.toString()]).toEqual(['94.7', '14.2', '326.7']);
    expect(l.adjustments).toEqual([{ type: 'DISCOUNT', sourceId: 'disc10', code: null, amount: d('-36.3') }]);
    expect([snapshot.subtotal, snapshot.discountTotal, snapshot.grandTotal]).toEqual([d('363'), d('36.3'), d('326.7')]);
  });

  it('puts no tax on a line whose price had no tax added, nor on any line when no tax is active', () => {
    const untaxed = snapshotOrder({ currency: 'GHS', lines: [line({ taxable: false })], taxes: GHANA, shipping: d(0) });
    const noTaxes = snapshotOrder({ currency: 'GHS', lines: [line()], taxes: [], shipping: d(0) });

    for (const snapshot of [untaxed, noTaxes]) {
      expect(snapshot.lines[0]).toMatchObject({ unitNet: d('121'), unitTax: d(0), taxLines: [] });
      expect(snapshot.taxTotal).toEqual(d(0));
    }
  });

  it('takes the coupon off the discounted lines as an order adjustment and adds shipping untaxed', () => {
    const snapshot = snapshotOrder({
      currency: 'GHS',
      lines: [line({ unitListPrice: d('100'), unitDiscount: d('10'), discountId: 'd', quantity: 2 })],
      taxes: [],
      shipping: d('5'),
      coupon: { couponId: 'c1', code: 'SAVE10', amount: d('18') },
    });

    expect(snapshot.adjustments).toEqual([{ type: 'COUPON', sourceId: 'c1', code: 'SAVE10', amount: d('-18') }]);
    expect(snapshot).toMatchObject({
      subtotal: d(200),
      discountTotal: d(38),
      shippingTotal: d(5),
      grandTotal: d(167),
    });
  });

  it('never lets a coupon take the order below zero', () => {
    const snapshot = snapshotOrder({
      currency: 'GHS',
      lines: [line({ unitListPrice: d('10'), taxable: false })],
      taxes: [],
      shipping: d('5'),
      coupon: { couponId: 'c1', code: 'BIG', amount: d('50') },
    });

    expect(snapshot.adjustments[0].amount).toEqual(d('-15'));
    expect(snapshot.grandTotal).toEqual(d(0));
  });

  it('records no coupon adjustment for a zero coupon', () => {
    const snapshot = snapshotOrder({
      currency: 'GHS',
      lines: [line()],
      taxes: [],
      shipping: d(0),
      coupon: { couponId: 'c1', code: 'ZERO', amount: d(0) },
    });

    expect(snapshot.adjustments).toEqual([]);
  });

  it.each([
    ['a quantity that is not a positive whole number', line({ quantity: 0 })],
    ['a discount above the list price', line({ unitDiscount: d('200') })],
    ['a negative discount', line({ unitDiscount: d('-1') })],
    ['a price in fractions of a pesewa', line({ unitListPrice: d('1.005') })],
  ])('refuses %s', (_case, bad) => {
    expect(() => snapshotOrder({ currency: 'GHS', lines: [bad], taxes: GHANA, shipping: d(0) })).toThrow(RangeError);
  });

  it('refuses negative shipping and negative tax rates', () => {
    expect(() => snapshotOrder({ currency: 'GHS', lines: [line()], taxes: [], shipping: d('-1') })).toThrow(RangeError);
    expect(() =>
      snapshotOrder({ currency: 'GHS', lines: [line()], taxes: [{ ...VAT, rate: d('-0.1') }], shipping: d(0) }),
    ).toThrow(RangeError);
  });

  describe('property: Σ line nets + adjustments + tax + shipping = grand total = the amount charged', () => {
    const seeds = [1, 7, 42, 2026, 31337];

    it.each(seeds)('holds for 400 random orders from seed %i', (seed) => {
      const next = sequence(seed);
      const pesewas = (max: number) => d(next(max)).div(100);
      const taxSets = [[], [VAT], GHANA, [{ taxId: 'odd', name: 'Odd', rate: d('0.0333') }, NHIL]];

      for (let run = 0; run < 400; run += 1) {
        const lines = Array.from({ length: 1 + next(6) }, (_, index) => {
          const unitListPrice = pesewas(500_000);
          const unitDiscount =
            next(3) === 0 ? d(0) : unitListPrice.mul(next(101)).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
          return line({
            variantId: `v${index}`,
            sku: `SKU-${index}`,
            quantity: 1 + next(12),
            unitListPrice,
            unitDiscount,
            taxable: next(4) !== 0,
          });
        });
        const coupon = next(2) === 0 ? { couponId: 'c', code: 'C', amount: pesewas(300_000) } : undefined;

        const snapshot = snapshotOrder({
          currency: 'GHS',
          lines,
          taxes: taxSets[next(taxSets.length)],
          shipping: pesewas(10_000),
          coupon,
        });

        expectBalanced(snapshot);
      }
    });
  });
});
