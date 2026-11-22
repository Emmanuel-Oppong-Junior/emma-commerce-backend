import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { OrderRefundStatus, RefundReason } from '../enums/refund-reason.enum';

@ObjectType({ description: 'Units of an order line a refund paid back' })
export class OrderRefundLine {
  @Field(() => ID)
  orderItemId: string;

  @Field({ description: 'The product name when ordered' })
  productName: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => MoneyObject)
  amount: Decimal;
}

/** A refund as its customer sees it: no internal note, staff or provider details. */
@ObjectType({ description: 'A refund of the order, as the customer sees it' })
export class OrderRefund {
  @Field(() => ID)
  id: string;

  @Field(() => MoneyObject)
  amount: Decimal;

  @Field(() => MoneyObject, { nullable: true, description: 'Tax included in the amount; null for older orders' })
  taxAmount: Decimal | null;

  @Field(() => MoneyObject, { description: 'The part of the amount that returns the delivery fee' })
  shippingAmount: Decimal;

  @Field(() => RefundReason)
  reason: RefundReason;

  @Field({ description: 'The reason in words, e.g. "Item arrived damaged"' })
  reasonLabel: string;

  @Field(() => OrderRefundStatus)
  status: OrderRefundStatus;

  @Field(() => [OrderRefundLine])
  lines: OrderRefundLine[];

  @Field()
  createdAt: Date;
}
