import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class DashboardSummary {
  @Field(() => Int)
  totalUsers: number;

  @Field(() => Int)
  ordersToday: number;

  @Field(() => Float)
  revenueToday: number;

  @Field(() => Int)
  lowStockProductCount: number;

  @Field(() => Int)
  lowStockVariantCount: number;
}
