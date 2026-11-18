import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RevenueByCategoryEntity {
  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field({ nullable: true })
  categoryName?: string;

  @Field(() => Float, { description: 'Item sales of this category in paid orders (unit price paid x quantity)' })
  totalRevenue: number;

  @Field(() => Int, { description: 'Paid orders containing this category' })
  orderCount: number;
}
