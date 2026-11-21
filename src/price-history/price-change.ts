import { Prisma, PriceChangeField, PriceChangeSource } from '../generated/prisma/client';

/** A variant's two stored prices. */
export interface VariantPrices {
  price: Prisma.Decimal | null;
  basePrice: Prisma.Decimal | null;
}

/** Why a price changed and who changed it; recorded on every PriceChange row of one write. */
export interface PriceChangeOrigin {
  source: PriceChangeSource;
  actorId: string | null;
  reason: string | null;
}

export interface FieldChange {
  field: PriceChangeField;
  oldValue: Prisma.Decimal | null;
  newValue: Prisma.Decimal;
}

const FIELDS: [PriceChangeField, keyof VariantPrices][] = [
  [PriceChangeField.BASE_PRICE, 'basePrice'],
  [PriceChangeField.PRICE, 'price'],
];

/** One change per price field that differs between `before` (null for a new variant) and `after`. */
export function priceFieldChanges(before: VariantPrices | null, after: VariantPrices): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, key] of FIELDS) {
    const oldValue = before?.[key] ?? null;
    const newValue = after[key];
    if (newValue === null) {
      if (oldValue !== null) throw new Error(`A variant's ${key} cannot be cleared (was ${oldValue.toFixed(2)})`);
      continue;
    }
    if (oldValue === null || !oldValue.equals(newValue)) changes.push({ field, oldValue, newValue });
  }
  return changes;
}
