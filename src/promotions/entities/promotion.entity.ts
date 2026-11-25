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
    BXGY: {
      description:
        'buy buyQuantity targeted units, get getQuantity reward units (the cheapest) value % off, mixing lines (not for CART)',
    },
    TIERED: {
      description:
        'the highest tier reached applies as tierValueType: by targeted units across lines (item scopes) or by spend (CART)',
    },
    FREE_SHIPPING: {
      description:
        'the delivery fee is waived (no value) or value comes off it, never below zero; CART scope, optionally per zone',
    },
  },
});

@ObjectType({ description: 'One tier of a TIERED promotion' })
export class PromotionTier {
  @Field(() => Int, { nullable: true, description: 'Item scopes: least targeted units, counted across lines' })
  minimumQuantity: number | null;

  @Field(() => MoneyObject, { nullable: true, description: 'CART: least merchandise total after item promotions' })
  minimumSpend: MoneySource | null;

  @Field(() => GraphQLDecimal, { description: 'A percentage, an amount off or a fixed unit price (tierValueType)' })
  value: Decimal;
}

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

  @Field(() => GraphQLDecimal, {
    nullable: true,
    description:
      'A percentage (PERCENT; BXGY: off each reward unit) or an amount in the store currency; null for TIERED',
  })
  value: Decimal | null;

  @Field(() => [ID], {
    description: "Ids of the scope's kind (variants, products, categories or brands); empty for CART",
  })
  targetIds: string[];

  @Field(() => Int, { nullable: true, description: 'BXGY: units of the targets to buy per application' })
  buyQuantity: number | null;

  @Field(() => Int, { nullable: true, description: 'BXGY: reward units per application' })
  getQuantity: number | null;

  @Field(() => Int, { nullable: true, description: 'BXGY: most applications per order; null for no limit' })
  maxApplications: number | null;

  @Field(() => [ID], { description: 'BXGY: reward targets, of the scope kind; empty for the targets themselves' })
  rewardTargetIds: string[];

  @Field(() => PromotionType, { nullable: true, description: 'TIERED: how each tier value reduces the price' })
  tierValueType: PromotionType | null;

  @Field(() => [PromotionTier], { description: 'TIERED: ascending tiers; empty otherwise' })
  tiers: PromotionTier[];

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

  @Field(() => Int, {
    nullable: true,
    description: 'Flash sale: units that may be sold at its price across all orders; null for no cap',
  })
  unitCap: number | null;

  @Field(() => Int, {
    description:
      'Units sold at its price by orders holding a use of it (given back on cancel or expiry before payment)',
  })
  unitsUsed: number;

  @Field(() => Int, { nullable: true, description: 'Orders each customer may use it on' })
  perCustomerLimit: number | null;

  @Field({ description: 'Only for a customer without an earlier confirmed or paid order' })
  firstOrderOnly: boolean;

  @Field(() => [ID], { description: 'Only for members of one of these customer groups; empty for everyone' })
  customerGroupIds: string[];

  @Field(() => [ID], {
    description: 'FREE_SHIPPING: only for deliveries to these shipping zones; empty for every zone',
  })
  shippingZoneIds: string[];

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

  @Field(() => ID, { nullable: true, description: 'The customer; null for a guest order (P6-G.1) not yet attached' })
  customerId: string | null;

  @Field(() => ID)
  orderId: string;

  @Field(() => RedemptionStatus)
  status: RedemptionStatus;

  @Field(() => Int, { description: 'Units the order bought at the promotional price (0 for a cart promotion)' })
  units: number;

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

  @Field(() => GraphQLDecimal, {
    nullable: true,
    description: 'A percentage (PERCENT, BXGY) or an amount in the store currency; null for TIERED',
  })
  value: Decimal | null;

  @Field(() => MoneyObject, { nullable: true, description: 'Least merchandise total the order needs' })
  minimumSpend: MoneySource | null;

  @Field(() => Int, { nullable: true })
  minimumQuantity: number | null;
}
