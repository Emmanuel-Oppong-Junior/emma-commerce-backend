import { Field, Int, ObjectType } from '@nestjs/graphql';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class DashboardSummary {
  @Field(() => Int)
  totalUsers: number;

  @Field(() => Int, { description: 'Orders paid today (salesReport.orderCount for today)' })
  ordersToday: number;

  @Field(() => MoneyObject, { description: 'Net revenue today (salesReport.netRevenue for today)' })
  revenueToday: Decimal;

  @Field(() => MoneyObject, { description: 'Payments accepted today (salesReport.grossRevenue for today)' })
  grossRevenueToday: Decimal;

  @Field(() => MoneyObject, { description: 'Refunds processed today (salesReport.refunds for today)' })
  refundsToday: Decimal;

  @Field(() => Int)
  lowStockProductCount: number;

  @Field(() => Int)
  lowStockVariantCount: number;
}
