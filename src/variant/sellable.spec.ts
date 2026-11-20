import { Prisma } from '../generated/prisma/client';
import { notSellableReason, SellableVariant } from './sellable';

describe('notSellableReason', () => {
  const sellable: SellableVariant = {
    sku: 'TSHIRT-M',
    isActive: true,
    price: new Prisma.Decimal('19.99'),
    product: { name: 'T-Shirt', isActive: true, status: 'PUBLISHED' },
  };

  it('returns null for an active, priced variant of an active published product', () => {
    expect(notSellableReason(sellable)).toBeNull();
  });

  it('refuses a variant of an inactive product', () => {
    expect(notSellableReason({ ...sellable, product: { ...sellable.product, isActive: false } })).toBe(
      '"T-Shirt" (TSHIRT-M) is not on sale',
    );
  });

  it.each(['DRAFT', 'ARCHIVED', null])('refuses a variant of a product whose status is %s', (status) => {
    expect(notSellableReason({ ...sellable, product: { ...sellable.product, status } })).toBe(
      '"T-Shirt" (TSHIRT-M) is not on sale',
    );
  });

  it('refuses an archived variant', () => {
    expect(notSellableReason({ ...sellable, isActive: false })).toBe('"T-Shirt" (TSHIRT-M) is no longer sold');
  });

  it('refuses an unpriced variant', () => {
    expect(notSellableReason({ ...sellable, price: null })).toBe(
      '"T-Shirt" (TSHIRT-M) has no price and cannot be sold',
    );
  });

  it('accepts a zero price, which is a price', () => {
    expect(notSellableReason({ ...sellable, price: new Prisma.Decimal(0) })).toBeNull();
  });

  it('reports the product before the variant when both are unsellable', () => {
    expect(
      notSellableReason({
        ...sellable,
        isActive: false,
        price: null,
        product: { ...sellable.product, status: 'DRAFT' },
      }),
    ).toBe('"T-Shirt" (TSHIRT-M) is not on sale');
  });
});
