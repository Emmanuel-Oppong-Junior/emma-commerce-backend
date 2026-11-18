import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TopProduct {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field(() => Int, { description: 'Units sold in paid orders' })
  totalQuantitySold: number;

  @Field(() => Float, { description: 'Item sales of this product in paid orders (unit price paid x quantity)' })
  totalRevenue: number;
}
