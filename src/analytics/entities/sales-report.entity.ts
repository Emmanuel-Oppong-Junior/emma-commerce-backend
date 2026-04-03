import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class SalesReport {
  @Field(() => Float)
  totalRevenue: number;

  @Field(() => Int)
  orderCount: number;

  @Field(() => Float)
  averageOrderValue: number;
}
