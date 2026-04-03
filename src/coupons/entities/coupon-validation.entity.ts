import { Field, Float, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class CouponValidation {
  @Field()
  valid: boolean;

  @Field(() => Float, { nullable: true })
  discountAmount?: number;

  @Field({ nullable: true })
  message?: string;
}
