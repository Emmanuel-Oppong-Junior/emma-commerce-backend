import { Field, Float, InputType } from '@nestjs/graphql';
import { IsNumber, IsString, Min } from 'class-validator';

@InputType()
export class ValidateCouponInput {
  @Field()
  @IsString()
  code: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  orderTotal: number;
}
