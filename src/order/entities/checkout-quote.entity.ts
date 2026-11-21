import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { GraphQLJSONObject } from 'graphql-type-json';
import { Currency, OrderAdjustmentType } from '../../generated/prisma/client';
import { MoneyObject } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { CurrencyEnum } from '../../products/enums/product.enum';
import { OrderAdjustmentTypeEnum } from '../enums/order.enum';

@ObjectType({ description: 'A tax included in a quote line' })
export class QuoteTaxLine {
  @Field(() => ID, { description: 'The tax rate it comes from' })
  taxId: string;

  @Field()
  name: string;

  @Field(() => GraphQLDecimal, { description: 'Rate as a decimal (e.g., 0.15 for 15%)' })
  rate: Decimal;

  @Field(() => MoneyObject, { description: 'The line amount without tax that the rate applies to' })
  base: Decimal;

  @Field(() => MoneyObject)
  amount: Decimal;
}

@ObjectType({ description: "An item discount taken off a quote line (already in the line's unitDiscount)" })
export class QuoteAdjustment {
  @Field(() => OrderAdjustmentTypeEnum)
  type: OrderAdjustmentType;

  @Field(() => ID, { description: 'The discount it comes from' })
  sourceId: string;

  @Field(() => String, { nullable: true })
  code: string | null;

  @Field(() => MoneyObject, { description: 'Signed amount: reductions are negative' })
  amount: Decimal;
}

@ObjectType({ description: "A cart line's share of an order-level adjustment" })
export class QuoteAllocation {
  @Field(() => ID)
  cartItemId: string;

  @Field(() => MoneyObject, { description: 'Signed share: reductions are negative' })
  amount: Decimal;
}

@ObjectType({ description: 'An order-level reduction (the coupon), split over the lines by largest remainder' })
export class QuoteOrderAdjustment {
  @Field(() => OrderAdjustmentTypeEnum)
  type: OrderAdjustmentType;

  @Field(() => ID, { description: 'The coupon it comes from' })
  sourceId: string;

  @Field(() => String, { nullable: true, description: 'Coupon code' })
  code: string | null;

  @Field(() => MoneyObject, { description: 'Signed amount: reductions are negative' })
  amount: Decimal;

  @Field(() => [QuoteAllocation], { description: "Each line's share; the shares add up exactly to amount" })
  allocations: QuoteAllocation[];
}

@ObjectType({ description: 'One cart line as checkout prices it' })
export class QuoteLine {
  @Field(() => ID)
  cartItemId: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field()
  sku: string;

  @Field(() => GraphQLJSONObject, { nullable: true, description: 'Option values, e.g. { size: "M" }' })
  optionValues: Record<string, unknown> | null;

  @Field(() => Int)
  quantity: number;

  @Field(() => MoneyObject, { description: 'Catalogue price of one unit, tax included' })
  unitListPrice: Decimal;

  @Field(() => MoneyObject, { description: 'Item discount taken off one unit' })
  unitDiscount: Decimal;

  @Field(() => MoneyObject, { description: 'One unit after its discount, without tax' })
  unitNet: Decimal;

  @Field(() => MoneyObject, { description: 'Tax included in one discounted unit' })
  unitTax: Decimal;

  @Field(() => MoneyObject, { description: '(unitListPrice - unitDiscount) x quantity, tax included' })
  lineTotal: Decimal;

  @Field(() => [QuoteAdjustment])
  adjustments: QuoteAdjustment[];

  @Field(() => [QuoteTaxLine])
  taxLines: QuoteTaxLine[];
}

@ObjectType({
  description:
    'The cart priced for checkout. createOrder charges exactly grandTotal when it is sent quoteHash and nothing changed',
})
export class CheckoutQuote {
  @Field({
    description:
      'Pass to createOrder. It covers every value that determines the charge; createOrder fails with CONFLICT ' +
      '(reason QUOTE_CHANGED) when any of them changed',
  })
  quoteHash: string;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field(() => Int, { description: 'The pricing rules that produced the quote' })
  pricingVersion: number;

  @Field(() => [QuoteLine], { description: 'In cart order' })
  lines: QuoteLine[];

  @Field(() => [QuoteOrderAdjustment], { description: 'The coupon, if it takes anything off' })
  adjustments: QuoteOrderAdjustment[];

  @Field(() => MoneyObject, { description: 'Sum of unit list price x quantity, before any discount, tax included' })
  subtotal: Decimal;

  @Field(() => MoneyObject, { description: 'Item discounts plus the coupon' })
  discountTotal: Decimal;

  @Field(() => MoneyObject, { description: 'Tax included in the line totals' })
  taxTotal: Decimal;

  @Field(() => MoneyObject, { description: 'Shipping (0 for pickup)' })
  shippingTotal: Decimal;

  @Field(() => MoneyObject, {
    description: 'The amount createOrder will charge: subtotal - discountTotal + shippingTotal',
  })
  grandTotal: Decimal;
}
