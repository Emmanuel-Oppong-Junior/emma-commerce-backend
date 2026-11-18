import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { RefundStatus } from '../../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { RefundStatusEnum } from '../enums/refund-status.enum';

@ObjectType()
export class RefundEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: 'The payment (attempt) the refund returns money from' })
  attemptId: string;

  @Field(() => ID, { nullable: true, description: 'Set when the refund belongs to a return request' })
  returnRequestId?: string | null;

  @Field(() => Float)
  amount: Decimal;

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
