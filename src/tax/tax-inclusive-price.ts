import { Prisma } from '../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { roundHalfUp } from '../commons/money/money';

/**
 * basePrice × (1 + totalRate) to 2 dp, half away from zero: the same result as Postgres `ROUND(numeric, 2)` in
 * `TaxRepository.repriceTaxableProducts`, so a product priced on save and one repriced by a tax change agree.
 */
export function taxInclusivePrice(basePrice: Decimal.Value, totalRate: Prisma.Decimal): Prisma.Decimal {
  return roundHalfUp(new Prisma.Decimal(basePrice).mul(totalRate.plus(1)));
}

/** A variant's selling price: its basePrice with tax added when its product is taxable (VAR-08). */
export function sellingPrice(basePrice: Decimal.Value, isTaxable: boolean, totalRate: Prisma.Decimal): Prisma.Decimal {
  return isTaxable ? taxInclusivePrice(basePrice, totalRate) : roundHalfUp(basePrice);
}
