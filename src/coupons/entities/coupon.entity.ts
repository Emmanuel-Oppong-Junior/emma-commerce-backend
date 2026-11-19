import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { DiscountTypeEnum } from '../enums/discount-type.enum';
import { DiscountType } from '../../generated/prisma/client';
import { MoneyObject } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class Coupon {
  @Field(() => ID)
  id: string;

  @Field()
  code: string;

  @Field(() => DiscountTypeEnum)
  discountType: DiscountType;

  @Field(() => GraphQLDecimal)
  value: Decimal;

  @Field(() => Int, { nullable: true })
  usageLimit?: number;

  @Field(() => Int)
  usedCount: number;

  @Field({ nullable: true })
  expiresAt?: Date;

  @Field()
  isActive: boolean;

  @Field(() => MoneyObject, { nullable: true })
  minimumOrderAmount?: Decimal;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
