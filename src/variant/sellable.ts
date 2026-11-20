import { Prisma } from '../generated/prisma/client';

export interface SellableVariant {
  sku: string;
  isActive: boolean;
  price: Prisma.Decimal | null;
  product: { name: string; isActive: boolean; status: string | null };
}

/**
 * Why a variant cannot be put in a cart or ordered, or null if it can: its product must be active and PUBLISHED,
 * the variant active (not archived) and priced. Stock is checked by the caller, which knows the quantity.
 */
export function notSellableReason(variant: SellableVariant): string | null {
  const name = `"${variant.product.name}" (${variant.sku})`;
  if (!variant.product.isActive || variant.product.status !== 'PUBLISHED') return `${name} is not on sale`;
  if (!variant.isActive) return `${name} is no longer sold`;
  if (variant.price === null) return `${name} has no price and cannot be sold`;
  return null;
}
