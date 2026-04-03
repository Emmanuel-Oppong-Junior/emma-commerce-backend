import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RevenueByCategoryEntity {
  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field({ nullable: true })
  categoryName?: string;

  @Field(() => Float)
  totalRevenue: number;

  @Field(() => Int)
  orderCount: number;
}
