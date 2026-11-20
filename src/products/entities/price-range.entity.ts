import { Field, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';

@ObjectType({ description: "Lowest and highest selling price of a product's active variants" })
export class PriceRange {
  @Field(() => MoneyObject)
  min: Decimal;

  @Field(() => MoneyObject)
  max: Decimal;
}
