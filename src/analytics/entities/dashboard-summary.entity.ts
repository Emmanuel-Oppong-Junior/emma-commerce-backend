import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class DashboardSummary {
  @Field(() => Int)
  totalUsers: number;

  @Field(() => Int, { description: 'Orders paid today (salesReport.orderCount for today)' })
  ordersToday: number;

  @Field(() => Float, { description: 'Net revenue today (salesReport.netRevenue for today)' })
  revenueToday: number;

  @Field(() => Float, { description: 'Payments accepted today (salesReport.grossRevenue for today)' })
  grossRevenueToday: number;

  @Field(() => Float, { description: 'Refunds processed today (salesReport.refunds for today)' })
  refundsToday: number;

  @Field(() => Int)
  lowStockProductCount: number;

  @Field(() => Int)
  lowStockVariantCount: number;
}
