import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { RefundStatus } from '../../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { RefundStatusEnum } from '../enums/refund-status.enum';
import { MoneyObject } from '../../commons/money/money.object';
import { RefundMethod, RefundReason } from '../enums/refund-reason.enum';

@ObjectType('RefundLine')
export class RefundLineEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderItemId: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => MoneyObject, {
    description: "What these units were charged: their share of the line total and of the order's cart discounts",
  })
  amount: Decimal;
}

@ObjectType()
export class RefundEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: 'The payment (attempt) the refund returns money from' })
  attemptId: string;

  @Field(() => ID, { nullable: true, description: 'Set when the refund belongs to a return request' })
  returnRequestId?: string | null;

  @Field(() => MoneyObject)
  amount: Decimal;

  @Field(() => MoneyObject, {
    nullable: true,
    description:
      "Tax included in the amount, from the order's stored tax lines in proportion; null for orders placed before " +
      'tax was recorded and for refunds of charges that never paid the order',
  })
  taxAmount?: Decimal | null;

  @Field()
  currency: string;

  @Field(() => RefundStatusEnum)
  status: RefundStatus;

  @Field(() => RefundReason)
  reason: RefundReason;

  @Field(() => String, { nullable: true, description: 'Internal staff note; never shown to the customer' })
  note?: string | null;

  @Field(() => RefundMethod)
  method: RefundMethod;

  @Field(() => MoneyObject, { description: "The part of the amount that returns the order's delivery fee" })
  shippingAmount: Decimal;

  @Field(() => ID, { nullable: true, description: 'The staff member who issued it with refundOrder' })
  createdById?: string | null;

  @Field(() => [RefundLineEntity], { description: 'The order line units it pays back (empty for amount-only refunds)' })
  lines?: RefundLineEntity[];

  @Field(() => String, { nullable: true, description: 'The refund id Paystack returned' })
  providerRef?: string | null;

  @Field(() => String, { nullable: true, description: 'Why the last send failed or has an unknown outcome' })
  failureReason?: string | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
