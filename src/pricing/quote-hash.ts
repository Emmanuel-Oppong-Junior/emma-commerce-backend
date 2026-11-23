import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/client';
import type { QuoteAdjustment, QuoteTaxLine, UnhashedQuote } from './price';

const amount = (value: Decimal) => value.toFixed(2);

const adjustment = (value: QuoteAdjustment) => [value.type, value.sourceId, value.code, amount(value.amount)];

const taxLine = (value: QuoteTaxLine) => [value.name, value.rate.toString(), amount(value.base), amount(value.amount)];

/**
 * SHA-256 (hex) over a canonical serialisation of everything that determines the charge: the currency, the pricing
 * version, each line's variant, quantity, prices, the price list it is priced from (list, break reached, whether
 * promotions apply), adjustments with their sources and tax lines, the order adjustments
 * (each line carries its share of them), the shipping adjustments, the delivery zone, the fee before promotions with
 * its rate rule, service level and delivery slot (PRICING_VERSION 5), shipping and the totals. Lines
 * are sorted, so the cart's line order does not matter (a split cart line is several lines). Ids that do not change
 * the amount (product, category, tax row) are left out; the zone stays in, since zone-limited free shipping depends on
 * it.
 */
export function quoteHash(quote: UnhashedQuote): string {
  const lines = quote.lines.map((_, index) => JSON.stringify(serialiseLine(quote, index))).sort();
  const canonical = {
    currency: quote.currency,
    pricingVersion: quote.pricingVersion,
    lines,
    adjustments: quote.adjustments.map(adjustment),
    shippingAdjustments: quote.shippingAdjustments.map(adjustment),
    shippingZoneId: quote.shippingZoneId,
    shippingFee: amount(quote.shippingFee),
    delivery: quote.delivery && [
      quote.delivery.rateRuleId,
      quote.delivery.serviceLevel,
      quote.delivery.slot && [
        quote.delivery.slot.slotId,
        quote.delivery.slot.date,
        quote.delivery.slot.startMinute,
        quote.delivery.slot.endMinute,
      ],
    ],
    totals: [quote.subtotal, quote.discountTotal, quote.taxTotal, quote.shippingTotal, quote.grandTotal].map(amount),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function serialiseLine(quote: UnhashedQuote, index: number) {
  const line = quote.lines[index];
  return [
    line.variantId,
    line.quantity,
    amount(line.unitListPrice),
    line.priceList && [line.priceList.priceListId, line.priceList.minQuantity, line.priceList.allowPromotions],
    amount(line.unitDiscount),
    amount(line.unitNet),
    amount(line.unitTax),
    amount(line.lineTotal),
    line.adjustments.map(adjustment),
    line.taxLines.map(taxLine),
    quote.adjustments.map((value) => amount(value.allocations[index])),
  ];
}
