import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { Currency } from '../../generated/prisma/client';
import { MoneyObject, MoneySource } from '../../commons/money/money.object';
import { CurrencyEnum } from '../../products/enums/product.enum';

@ObjectType({ description: 'A quantity break of a price-list entry' })
export class PriceListTier {
  @Field(() => Int)
  minQuantity: number;

  @Field(() => MoneyObject, { description: 'Unit price from minQuantity units, tax included' })
  price: MoneySource;
}

@ObjectType({ description: "A variant's price in a price list (staff view)" })
export class PriceListEntry {
  @Field(() => ID)
  variantId: string;

  @Field(() => MoneyObject, { description: 'Unit price from minQuantity units, tax included' })
  price: MoneySource;

  @Field(() => Int, { description: 'Minimum quantity (MOQ) for the list price; below it the normal price applies' })
  minQuantity: number;

  @Field(() => [PriceListTier], { description: 'Lower prices for larger quantities, ascending' })
  tiers: PriceListTier[];

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType()
export class PriceListEntryPage {
  @Field(() => [PriceListEntry])
  nodes: PriceListEntry[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node variantId as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType({
  description:
    'A B2B price list (staff view): members of its customer groups pay its entries instead of the normal price',
})
export class PriceList {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field()
  isActive: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  startsAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endsAt: Date | null;

  @Field(() => Int)
  priority: number;

  @Field()
  allowPromotions: boolean;

  @Field(() => [ID])
  customerGroupIds: string[];

  @Field(() => Int)
  entryCount: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType({ description: 'What the signed-in customer pays per unit from a quantity, from their price lists' })
export class VariantPriceTier {
  @Field(() => Int)
  minQuantity: number;

  @Field(() => MoneyObject, { description: 'Unit price, tax included, before promotions' })
  unitPrice: MoneySource;

  @Field({ description: 'Whether promotions may apply on top of this price' })
  promotionsApply: boolean;
}
