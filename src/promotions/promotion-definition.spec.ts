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
  ])('refuses %s', (_case, invalid, message) => {
    expect(promotionDefinitionError(invalid)).toContain(message);
  });
});
