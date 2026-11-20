import { Field, ID, ObjectType } from '@nestjs/graphql';
import { RefundStatus } from '../../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { RefundStatusEnum } from '../enums/refund-status.enum';
import { MoneyObject } from '../../commons/money/money.object';

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

  @Field(() => String, { nullable: true, description: 'The refund id Paystack returned' })
  providerRef?: string | null;

  @Field(() => String, { nullable: true, description: 'Why the last send failed or has an unknown outcome' })
  failureReason?: string | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
