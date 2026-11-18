import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { DiscountTypeEnum } from '../enums/discount-type.enum';
import { DiscountType } from '../../generated/prisma/client';

@ObjectType()
export class Coupon {
  @Field(() => ID)
  id: string;

  @Field()
  code: string;

  @Field(() => DiscountTypeEnum)
  discountType: DiscountType;

  @Field(() => Float)
  value: number;

  @Field(() => Int, { nullable: true })
  usageLimit?: number;

  @Field(() => Int)
  usedCount: number;

  @Field({ nullable: true })
  expiresAt?: Date;

  @Field()
  isActive: boolean;

  @Field(() => Float, { nullable: true })
  minimumOrderAmount?: number;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
