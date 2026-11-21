import { Decimal } from '@prisma/client/runtime/client';

export interface PriceListEntryDefinition {
  variantId: string;
  price: Decimal;
  minQuantity: number;
  tiers: readonly { minQuantity: number; price: Decimal }[];
}

/**
 * Why a price-list entry is invalid, or null when it is valid: a positive price from a minimum quantity of at least 1,
 * and tiers that start above that minimum, ascend by quantity and never cost more per unit than the break below.
 */
export function priceListEntryError(entry: PriceListEntryDefinition): string | null {
  if (!entry.price.gt(0)) return `Variant "${entry.variantId}": price must be above 0`;
  if (!Number.isInteger(entry.minQuantity) || entry.minQuantity < 1) {
    return `Variant "${entry.variantId}": minQuantity must be a whole number of at least 1`;
  }
  let previous = { minQuantity: entry.minQuantity, price: entry.price };
  for (const tier of entry.tiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity <= previous.minQuantity) {
      return `Variant "${entry.variantId}": tier minQuantity values must ascend above minQuantity ${entry.minQuantity}`;
    }
    if (!tier.price.gt(0) || tier.price.gt(previous.price)) {
      return `Variant "${entry.variantId}": a tier price must be above 0 and at most the price below it (${previous.price.toString()})`;
    }
    previous = tier;
  }
  return null;
}

/** Why a batch of entries is invalid (each entry, and each variant at most once), or null. */
export function priceListEntriesError(entries: readonly PriceListEntryDefinition[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.variantId)) return `Variant "${entry.variantId}" is given more than once`;
    seen.add(entry.variantId);
    const error = priceListEntryError(entry);
    if (error) return error;
  }
  return null;
}
