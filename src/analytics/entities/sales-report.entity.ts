import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    'Revenue recognised in a period. A payment counts when it is accepted for its order (online payment settled, or cash collected); a refund counts when it is processed.',
})
export class SalesReport {
  @Field(() => Float, {
    description: 'Payments accepted for orders in the period (order totals incl. shipping, after coupons)',
  })
  grossRevenue: number;

  @Field(() => Float, { description: 'Refunds processed in the period against accepted payments' })
  refunds: number;

  @Field(() => Float, { description: 'grossRevenue minus refunds' })
  netRevenue: number;

  @Field(() => Float, { deprecationReason: 'Same value as netRevenue; use netRevenue.' })
  totalRevenue: number;

  @Field(() => Float, {
    description:
      'Item sales (unit price paid x quantity) of the orders paid in the period. grossRevenue = itemSales + shipping fees - coupon discounts.',
  })
  itemSales: number;

  @Field(() => Int, { description: 'Orders paid in the period' })
  orderCount: number;

  @Field(() => Float, { description: 'grossRevenue / orderCount' })
  averageOrderValue: number;
}
