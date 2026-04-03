import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TopProduct {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field(() => Int)
  totalQuantitySold: number;

  @Field(() => Float)
  totalRevenue: number;
}
