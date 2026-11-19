import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ReturnStatusEnum } from '../enums/return-status.enum';
import { ReturnStatus } from '../../generated/prisma/client';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class ReturnRequestEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ID)
  userId: string;

  @Field()
  reason: string;

  @Field(() => ReturnStatusEnum)
  status: ReturnStatus;

  @Field(() => MoneyObject, { nullable: true })
  refundAmount?: Decimal;

  @Field({ nullable: true })
  adminNote?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
