import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { ReturnStatusEnum } from '../enums/return-status.enum';
import { ReturnStatus } from '../../generated/prisma/client';

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

  @Field(() => Float, { nullable: true })
  refundAmount?: number;

  @Field({ nullable: true })
  adminNote?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
