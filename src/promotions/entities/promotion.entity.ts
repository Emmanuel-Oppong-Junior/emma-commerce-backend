import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { PromotionScope, PromotionType, RedemptionStatus } from '../../generated/prisma/client';
import { MoneyObject, MoneySource } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';

registerEnumType(PromotionScope, {
  name: 'PromotionScope',
  description: 'What a promotion targets',
  valuesMap: {
    SKU: { description: 'Chosen variants (targetIds are variant ids)' },
    PRODUCT: { description: 'Every variant of chosen products' },
    CATEGORY: { description: 'Products of chosen categories' },
    BRAND: { description: 'Products of chosen brands' },
    CART: { description: 'The whole cart, after item promotions (no targets)' },
  },
});

registerEnumType(PromotionType, {
  name: 'PromotionType',
  description: 'How a promotion reduces the price',
  valuesMap: {
    PERCENT: { description: 'value is a percentage, 0 to 100' },
    AMOUNT_OFF: { description: 'value comes off each targeted unit, or off the cart (CART scope)' },
    FIXED_PRICE: { description: 'each targeted unit costs value, never more than its price (not for CART)' },
  },
});

registerEnumType(RedemptionStatus, {
  name: 'RedemptionStatus',
  valuesMap: {
    RESERVED: { description: 'Counted against the limits since the order was placed' },
    RELEASED: { description: 'Given back: the order was cancelled or expired before payment' },
  },
});

@ObjectType({ description: 'A code that unlocks a promotion at checkout (staff view)' })
export class CouponCode {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Upper case; customers may enter it in any case' })
  code: string;

  @Field(() => ID)
  promotionId: string;

  @Field()
  isActive: boolean;

  @Field(() => Int, { nullable: true, description: 'Orders that may use this code; null for no limit' })
  usageLimit: number | null;

  @Field(() => Int, { description: 'Orders holding a use of this code' })
  usedCount: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType({ description: 'A promotion with its rules, targets, limits and coupon codes (staff view)' })
export class Promotion {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => PromotionScope)
  scope: PromotionScope;

  @Field(() => PromotionType)
  type: PromotionType;

  @Field(() => GraphQLDecimal, { description: 'A percentage (PERCENT) or an amount in the store currency' })
  value: Decimal;

  @Field(() => [ID], {
    description: "Ids of the scope's kind (variants, products, categories or brands); empty for CART",
  })
  targetIds: string[];

  @Field(() => MoneyObject, { nullable: true, description: 'Least merchandise total the order needs' })
  minimumSpend: MoneySource | null;

  @Field(() => Int, { nullable: true, description: 'Least number of targeted units (any unit for CART) in the cart' })
  minimumQuantity: number | null;

  @Field(() => GraphQLISODateTime)
  startsAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null for open-ended' })
  endsAt: Date | null;

  @Field()
  isActive: boolean;

  @Field(() => Int, { description: 'Breaks ties between equal savings: the lowest number wins, then the oldest' })
  priority: number;

  @Field({ description: 'Promotions of one group (per level: item or cart) do not combine; the best saving applies' })
  stackingGroup: string;

  @Field({ description: 'When it applies, no other promotion does' })
  exclusive: boolean;

  @Field({ description: 'Only an order that enters one of its coupon codes gets it' })
  requiresCoupon: boolean;

  @Field(() => Int, { nullable: true, description: 'Orders that may use it, across all customers' })
  usageLimit: number | null;

  @Field(() => Int, { description: 'Orders holding a use of it' })
  usedCount: number;

  @Field(() => Int, { nullable: true, description: 'Orders each customer may use it on' })
  perCustomerLimit: number | null;

  @Field(() => [CouponCode])
  couponCodes: CouponCode[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType({ description: 'One promotion used by one order (staff view)' })
export class Redemption {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  promotionId: string;

  @Field(() => ID, { nullable: true })
  couponCodeId: string | null;

  @Field(() => ID)
  customerId: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => RedemptionStatus)
  status: RedemptionStatus;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  releasedAt: Date | null;
}

@ObjectType()
export class RedemptionPage {
  @Field(() => [Redemption])
  nodes: Redemption[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType({ description: 'What a customer may see of a promotion' })
export class PublicPromotion {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it ends; null for open-ended' })
  endsAt: Date | null;
}

@ObjectType({ description: 'What a coupon code unlocks for the signed-in customer' })
export class CouponCodeValidation {
  @Field({ description: 'The code as stored (upper case)' })
  code: string;

  @Field(() => PublicPromotion)
  promotion: PublicPromotion;

  @Field(() => PromotionScope)
  scope: PromotionScope;

  @Field(() => PromotionType)
  type: PromotionType;

  @Field(() => GraphQLDecimal, { description: 'A percentage (PERCENT) or an amount in the store currency' })
  value: Decimal;

  @Field(() => MoneyObject, { nullable: true, description: 'Least merchandise total the order needs' })
  minimumSpend: MoneySource | null;

  @Field(() => Int, { nullable: true })
  minimumQuantity: number | null;
}
