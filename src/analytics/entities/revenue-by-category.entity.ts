import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class RevenueByCategoryEntity {
  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field({ nullable: true })
  categoryName?: string;

  @Field(() => MoneyObject, { description: 'Item sales of this category in paid orders (unit price paid x quantity)' })
  totalRevenue: Decimal;

  @Field(() => Int, { description: 'Paid orders containing this category' })
  orderCount: number;
}
