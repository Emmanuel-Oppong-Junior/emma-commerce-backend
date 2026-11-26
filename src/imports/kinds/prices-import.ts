import { ImportRowAction, Prisma } from '../../generated/prisma/client';
import { sellingPrice } from '../../tax/tax-inclusive-price';
import { ImportColumns, parseAmount, RowOutcome, textProblem } from './import-rows';

export const PRICE_COLUMNS: ImportColumns = { required: ['sku', 'base_price'], optional: ['reason'], prefixes: [] };

export const PRICE_TEMPLATE_EXAMPLE: Record<string, string> = {
  sku: 'TSHIRT-RED-M',
  base_price: '120.00',
  reason: 'November price review',
};

const MAX_REASON_LENGTH = 500;

export interface VariantPriceFacts {
  id: string;
  basePrice: Prisma.Decimal | null;
  price: Prisma.Decimal | null;
  isTaxable: boolean;
}

export interface PricePlan {
  variantId: string;
  basePrice: Prisma.Decimal;
  price: Prisma.Decimal;
  reason: string | null;
}

/**
 * One PRICES row: the variant's new tax-exclusive base_price. The selling price follows from it as everywhere else
 * (tax added for a taxable product), so the file never sets the two apart. Unchanged prices are NONE.
 */
export function planPriceRow(
  values: Record<string, string>,
  variant: VariantPriceFacts | undefined,
  taxRate: Prisma.Decimal,
): RowOutcome & { plan?: PricePlan } {
  const errors: string[] = [];
  if (!values.sku) errors.push('sku is required');
  else if (!variant) errors.push(`No variant has SKU "${values.sku}"`);
  let basePrice: Prisma.Decimal | undefined;
  if (!values.base_price) errors.push('base_price is required');
  else {
    const parsed = parseAmount('base_price', values.base_price);
    if (parsed.ok) basePrice = parsed.value;
    else errors.push(parsed.error);
  }
  const reasonProblem = textProblem('reason', values.reason, MAX_REASON_LENGTH);
  if (reasonProblem) errors.push(reasonProblem);
  if (errors.length || !variant || !basePrice) return { errors, warnings: [], action: ImportRowAction.NONE };

  const price = sellingPrice(basePrice, variant.isTaxable, taxRate);
  const unchanged = variant.basePrice?.equals(basePrice) && variant.price?.equals(price);
  return {
    errors,
    warnings: [],
    action: unchanged ? ImportRowAction.NONE : ImportRowAction.UPDATE,
    plan: { variantId: variant.id, basePrice, price, reason: values.reason ?? null },
  };
}
