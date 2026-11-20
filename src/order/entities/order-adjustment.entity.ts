import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { OrderAdjustmentTypeEnum } from '../enums/order.enum';
import { OrderAdjustmentType } from '../../generated/prisma/client';

@ObjectType({ description: 'A discount or coupon taken off the order when it was placed' })
export class OrderAdjustment {
  @Field(() => ID)
  id: string;

  @Field(() => ID, {
    nullable: true,
    description: 'The line it applies to (a product discount, already in its unitDiscount); null for the coupon',
  })
  orderItemId?: string | null;

  @Field(() => OrderAdjustmentTypeEnum)
  type: OrderAdjustmentType;

  @Field(() => ID, { nullable: true, description: 'The discount or coupon it came from' })
  sourceId?: string | null;

  @Field(() => String, { nullable: true, description: 'Coupon code when ordered' })
  code?: string | null;

  @Field(() => MoneyObject, { description: 'Signed amount: reductions are negative' })
  amount: Decimal;
}
