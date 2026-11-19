import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class TopProduct {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field(() => Int, { description: 'Units sold in paid orders' })
  totalQuantitySold: number;

  @Field(() => MoneyObject, { description: 'Item sales of this product in paid orders (unit price paid x quantity)' })
  totalRevenue: Decimal;
}
