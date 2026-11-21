import { Decimal } from '@prisma/client/runtime/client';
import { PromotionDefinition, promotionDefinitionError } from './promotion-definition';

const START = new Date('2026-11-01T00:00:00.000Z');
const definition = (overrides: Partial<PromotionDefinition> = {}): PromotionDefinition => ({
  scope: 'PRODUCT',
  type: 'PERCENT',
  value: new Decimal(20),
  targetIds: ['p1'],
  startsAt: START,
  endsAt: null,
  unitCap: null,
  buyQuantity: null,
  getQuantity: null,
  maxApplications: null,
  rewardTargetIds: [],
  tierValueType: null,
  tiers: [],
  ...overrides,
});
const bxgy = (overrides: Partial<PromotionDefinition> = {}) =>
  definition({ type: 'BXGY', value: new Decimal(100), buyQuantity: 2, getQuantity: 1, ...overrides });
const quantityTier = (minimumQuantity: number, value: Decimal.Value) => ({
  minimumQuantity,
  minimumSpend: null,
  value: new Decimal(value),
});
const spendTier = (minimumSpend: Decimal.Value, value: Decimal.Value) => ({
  minimumQuantity: null,
  minimumSpend: new Decimal(minimumSpend),
  value: new Decimal(value),
});
const volume = (overrides: Partial<PromotionDefinition> = {}) =>
  definition({
    type: 'TIERED',
    value: null,
    tierValueType: 'PERCENT',
    tiers: [quantityTier(3, 10), quantityTier(6, 15)],
    ...overrides,
  });
const spend = (overrides: Partial<PromotionDefinition> = {}) =>
  volume({
    scope: 'CART',
    targetIds: [],
    tierValueType: 'AMOUNT_OFF',
    tiers: [spendTier(500, 50), spendTier(1000, 120)],
    ...overrides,
  });

describe('promotionDefinitionError', () => {
  it.each([
    ['a percentage of 100', definition({ value: new Decimal(100) })],
    ['an open-ended promotion', definition()],
    ['an item promotion without targets yet', definition({ targetIds: [] })],
    ['a fixed price on a SKU', definition({ scope: 'SKU', type: 'FIXED_PRICE', value: new Decimal(500) })],
    ['an amount off the cart', definition({ scope: 'CART', type: 'AMOUNT_OFF', targetIds: [] })],
    ['a flash sale capped at 50 units', definition({ unitCap: 50 })],
    ['buy 2 get 1 free', bxgy()],
    [
      'buy 1 get 1 half price, twice at most, rewarding other targets',
      bxgy({ value: new Decimal(50), maxApplications: 2, rewardTargetIds: ['p2'] }),
    ],
    ['volume tiers', volume()],
    [
      'fixed-price volume tiers falling as they rise',
      volume({ tierValueType: 'FIXED_PRICE', tiers: [quantityTier(2, 90), quantityTier(5, 80)] }),
    ],
    ['spend X save Y', spend()],
  ])('accepts %s', (_case, valid) => {
    expect(promotionDefinitionError(valid)).toBeNull();
  });

  it.each([
    ['a percentage above 100', definition({ value: new Decimal('100.01') }), 'at most 100'],
    ['a fixed cart price', definition({ scope: 'CART', type: 'FIXED_PRICE', targetIds: [] }), 'FIXED_PRICE'],
    ['targets on a cart promotion', definition({ scope: 'CART', type: 'AMOUNT_OFF' }), 'takes no targetIds'],
    ['an end at its start', definition({ endsAt: START }), 'endsAt must be after startsAt'],
    [
      'a unit cap on a cart promotion',
      definition({ scope: 'CART', type: 'AMOUNT_OFF', targetIds: [], unitCap: 5 }),
      'cannot have a unitCap',
    ],
    ['a simple promotion without value', definition({ value: null }), 'needs a value'],
    ['BXGY without quantities', bxgy({ getQuantity: null }), 'needs buyQuantity and getQuantity'],
    ['BXGY above 100 percent', bxgy({ value: new Decimal(101) }), 'at most 100'],
    ['BXGY at 0 percent', bxgy({ value: new Decimal(0) }), 'above 0'],
    ['BXGY on the cart', bxgy({ scope: 'CART', targetIds: [] }), 'item scope'],
    ['BXGY fields on a percentage', definition({ buyQuantity: 2, rewardTargetIds: ['p2'] }), 'BXGY promotions only'],
    ['a value on TIERED', volume({ value: new Decimal(5) }), 'takes no value'],
    ['TIERED without tiers', volume({ tiers: [] }), 'at least one tier'],
    ['TIERED without tierValueType', volume({ tierValueType: null }), 'needs tierValueType'],
    ['tiers on a percentage', definition({ tiers: [quantityTier(2, 5)] }), 'TIERED promotions only'],
    ['descending tiers', volume({ tiers: [quantityTier(6, 15), quantityTier(3, 10)] }), 'ascending'],
    ['overlapping tiers', volume({ tiers: [quantityTier(3, 10), quantityTier(3, 15)] }), 'ascending'],
    ['a higher tier worth less', volume({ tiers: [quantityTier(3, 15), quantityTier(6, 10)] }), 'worth less'],
    ['a tier percentage above 100', volume({ tiers: [quantityTier(3, 101)] }), 'at most 100'],
    ['a spend threshold on an item tier', volume({ tiers: [spendTier(100, 5)] }), 'minimumQuantity'],
    ['a quantity threshold on a cart tier', spend({ tiers: [quantityTier(3, 5)] }), 'minimumSpend'],
    ['fixed-price cart tiers', spend({ tierValueType: 'FIXED_PRICE' }), 'FIXED_PRICE'],
  ])('refuses %s', (_case, invalid, message) => {
    expect(promotionDefinitionError(invalid)).toContain(message);
  });
});
