import { Prisma } from '../generated/prisma/client';
import { priceFieldChanges } from './price-change';

const d = (value: string) => new Prisma.Decimal(value);

describe('priceFieldChanges', () => {
  it('records both prices of a new variant with no old value', () => {
    expect(priceFieldChanges(null, { basePrice: d('10.00'), price: d('11.50') })).toEqual([
      { field: 'BASE_PRICE', oldValue: null, newValue: d('10.00') },
      { field: 'PRICE', oldValue: null, newValue: d('11.50') },
    ]);
  });

  it('records only the fields whose value changed', () => {
    const before = { basePrice: d('10.00'), price: d('10.00') };

    expect(priceFieldChanges(before, { basePrice: d('10.00'), price: d('11.50') })).toEqual([
      { field: 'PRICE', oldValue: d('10.00'), newValue: d('11.50') },
    ]);
  });

  it('treats equal amounts with a different scale as unchanged', () => {
    const before = { basePrice: d('10'), price: d('10.5') };

    expect(priceFieldChanges(before, { basePrice: d('10.00'), price: d('10.50') })).toEqual([]);
  });

  it('records the first price of an unpriced variant with no old value', () => {
    expect(priceFieldChanges({ basePrice: null, price: null }, { basePrice: d('5.00'), price: d('5.00') })).toEqual([
      { field: 'BASE_PRICE', oldValue: null, newValue: d('5.00') },
      { field: 'PRICE', oldValue: null, newValue: d('5.00') },
    ]);
  });

  it('skips a field that stays unpriced', () => {
    expect(priceFieldChanges({ basePrice: null, price: d('9.99') }, { basePrice: null, price: d('9.99') })).toEqual([]);
  });

  it('refuses to clear a price', () => {
    const before = { basePrice: d('5.00'), price: d('5.00') };

    expect(() => priceFieldChanges(before, { basePrice: null, price: d('5.00') })).toThrow(
      "A variant's basePrice cannot be cleared (was 5.00)",
    );
  });
});
