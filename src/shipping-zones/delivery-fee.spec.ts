import { Decimal } from '@prisma/client/runtime/client';
import { DeliveryRate, deliveryFee, offeredLevels, rateRuleProblem } from './delivery-fee';

const d = (value: number | string) => new Decimal(value);
const rule = (overrides: Partial<DeliveryRate> = {}): DeliveryRate => ({
  id: 'std',
  serviceLevel: 'STANDARD',
  baseFee: d(15),
  freeAbove: null,
  isActive: true,
  weightBands: [],
  ...overrides,
});
const banded = rule({
  weightBands: [
    { fromGrams: 5000, fee: d(25) },
    { fromGrams: 20000, fee: d(60) },
  ],
});

describe('deliveryFee', () => {
  it('charges the base fee below every weight band', () => {
    expect(deliveryFee([banded], 'STANDARD', 4999, d(100))).toEqual({
      rateRuleId: 'std',
      serviceLevel: 'STANDARD',
      fee: d(15),
      weightBandFromGrams: null,
      freeAboveReached: false,
    });
  });

  it.each([
    [5000, 25, 5000],
    [19999, 25, 5000],
    [20000, 60, 20000],
    [90000, 60, 20000],
  ])('charges the heaviest band %i g reaches', (weight, fee, band) => {
    expect(deliveryFee([banded], 'STANDARD', weight, d(100))).toMatchObject({
      fee: d(fee),
      weightBandFromGrams: band,
    });
  });

  it('waives the fee once the merchandise total reaches the free-above threshold, heavy or not', () => {
    const free = rule({ ...banded, freeAbove: d(500) });

    expect(deliveryFee([free], 'STANDARD', 30000, d('499.99'))).toMatchObject({ fee: d(60), freeAboveReached: false });
    expect(deliveryFee([free], 'STANDARD', 30000, d(500))).toMatchObject({ fee: d(0), freeAboveReached: true });
  });

  it('prices the level asked for and nothing for a level the zone does not offer', () => {
    const rules = [rule(), rule({ id: 'exp', serviceLevel: 'EXPRESS', baseFee: d(40) })];

    expect(deliveryFee(rules, 'EXPRESS', 0, d(0))).toMatchObject({ rateRuleId: 'exp', fee: d(40) });
    expect(deliveryFee([rule()], 'EXPRESS', 0, d(0))).toBeNull();
  });

  it('skips inactive rules', () => {
    expect(deliveryFee([rule({ isActive: false })], 'STANDARD', 0, d(0))).toBeNull();
    expect(offeredLevels([rule({ isActive: false }), rule({ serviceLevel: 'EXPRESS' })])).toEqual(['EXPRESS']);
  });
});

describe('rateRuleProblem', () => {
  it('accepts ascending bands that never get cheaper', () => {
    expect(rateRuleProblem(banded)).toBeNull();
    expect(rateRuleProblem(rule({ weightBands: [{ fromGrams: 1, fee: d(15) }] }))).toBeNull();
  });

  it.each([
    ['a band at 0 g', [{ fromGrams: 0, fee: d(20) }]],
    ['a fractional weight', [{ fromGrams: 1.5, fee: d(20) }]],
    [
      'bands out of order',
      [
        { fromGrams: 5000, fee: d(20) },
        { fromGrams: 1000, fee: d(25) },
      ],
    ],
    [
      'a repeated weight',
      [
        { fromGrams: 5000, fee: d(20) },
        { fromGrams: 5000, fee: d(25) },
      ],
    ],
    ['a band cheaper than the base fee', [{ fromGrams: 5000, fee: d(10) }]],
    [
      'a heavier band cheaper than a lighter one',
      [
        { fromGrams: 5000, fee: d(30) },
        { fromGrams: 9000, fee: d(20) },
      ],
    ],
  ])('refuses %s', (_name, weightBands) => {
    expect(rateRuleProblem(rule({ weightBands }))).toEqual(expect.any(String));
  });
});
