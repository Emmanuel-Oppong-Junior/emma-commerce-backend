import { Field, ObjectType } from '@nestjs/graphql';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class CouponValidation {
  @Field()
  valid: boolean;

  @Field(() => MoneyObject, { nullable: true })
  discountAmount?: Decimal;

  @Field({ nullable: true })
  message?: string;
}
