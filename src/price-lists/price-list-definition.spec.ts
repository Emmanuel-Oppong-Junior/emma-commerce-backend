import { Decimal } from '@prisma/client/runtime/client';
import { PriceListEntryDefinition, priceListEntriesError, priceListEntryError } from './price-list-definition';

const d = (value: Decimal.Value) => new Decimal(value);
const entry = (overrides: Partial<PriceListEntryDefinition> = {}): PriceListEntryDefinition => ({
  variantId: 'v1',
  price: d(90),
  minQuantity: 1,
  tiers: [],
  ...overrides,
});

describe('price-list entry definition', () => {
  it('accepts a price from a minimum quantity with ascending, never dearer tiers (equal prices allowed)', () => {
    expect(
      priceListEntryError(
        entry({
          minQuantity: 5,
          tiers: [
            { minQuantity: 10, price: d(80) },
            { minQuantity: 20, price: d(80) },
            { minQuantity: 50, price: d(70) },
          ],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['a zero price', entry({ price: d(0) }), 'price must be above 0'],
    ['a minimum quantity of 0', entry({ minQuantity: 0 }), 'at least 1'],
    ['a fractional minimum quantity', entry({ minQuantity: 1.5 }), 'at least 1'],
    ['a tier at the minimum quantity', entry({ minQuantity: 5, tiers: [{ minQuantity: 5, price: d(80) }] }), 'ascend'],
    [
      'tiers out of order',
      entry({
        tiers: [
          { minQuantity: 20, price: d(80) },
          { minQuantity: 10, price: d(70) },
        ],
      }),
      'ascend',
    ],
    ['a dearer tier', entry({ tiers: [{ minQuantity: 10, price: d('90.01') }] }), 'at most the price below it (90)'],
    ['a zero tier price', entry({ tiers: [{ minQuantity: 10, price: d(0) }] }), 'above 0'],
  ])('refuses %s', (_case, invalid, message) => {
    expect(priceListEntryError(invalid)).toContain(message);
  });

  it('refuses a batch naming a variant twice, or holding an invalid entry', () => {
    expect(priceListEntriesError([entry(), entry({ variantId: 'v2' })])).toBeNull();
    expect(priceListEntriesError([entry(), entry()])).toBe('Variant "v1" is given more than once');
    expect(priceListEntriesError([entry(), entry({ variantId: 'v2', price: d(0) })])).toContain('Variant "v2"');
  });
});
