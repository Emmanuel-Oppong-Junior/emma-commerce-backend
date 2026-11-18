import { Prisma } from '../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';

/**
 * basePrice × (1 + totalRate) to 2 dp, half away from zero: the same result as Postgres `ROUND(numeric, 2)` in
 * `TaxRepository.repriceTaxableProducts`, so a product priced on save and one repriced by a tax change agree.
 */
export function taxInclusivePrice(basePrice: Decimal.Value, totalRate: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(basePrice).mul(totalRate.plus(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
