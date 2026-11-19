import { Field, Int, ObjectType } from '@nestjs/graphql';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType({
  description:
    'Revenue recognised in a period. A payment counts when it is accepted for its order (online payment settled, or cash collected); a refund counts when it is processed.',
})
export class SalesReport {
  @Field(() => MoneyObject, {
    description: 'Payments accepted for orders in the period (order totals incl. shipping, after coupons)',
  })
  grossRevenue: Decimal;

  @Field(() => MoneyObject, { description: 'Refunds processed in the period against accepted payments' })
  refunds: Decimal;

  @Field(() => MoneyObject, { description: 'grossRevenue minus refunds' })
  netRevenue: Decimal;

  @Field(() => MoneyObject, { deprecationReason: 'Same value as netRevenue; use netRevenue.' })
  totalRevenue: Decimal;

  @Field(() => MoneyObject, {
    description:
      'Item sales (unit price paid x quantity) of the orders paid in the period. grossRevenue = itemSales + shipping fees - coupon discounts.',
  })
  itemSales: Decimal;

  @Field(() => Int, { description: 'Orders paid in the period' })
  orderCount: number;

  @Field(() => MoneyObject, { description: 'grossRevenue / orderCount' })
  averageOrderValue: Decimal;
}
