import { Field, InputType } from '@nestjs/graphql';
import { IsString } from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class ValidateCouponInput {
  @Field()
  @IsString()
  code: string;

  @DecimalInputField()
  @IsMoneyAmount()
  orderTotal: Decimal;
}
