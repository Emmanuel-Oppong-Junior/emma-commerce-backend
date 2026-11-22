import { Field, GraphQLISODateTime, ID, InputType } from '@nestjs/graphql';
import { IsDate, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';

@InputType()
export class RecordCodPaymentInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @Field(() => ID, { description: 'The staff member who took the cash (an active account with a store role)' })
  @IsString()
  @IsNotEmpty()
  riderId: string;

  @DecimalInputField({ description: "The cash taken; must equal the order's grandTotal" })
  @IsMoneyAmount()
  amount: Decimal;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the cash was taken (default now); not in the future nor before dispatch',
  })
  @IsOptional()
  @IsDate()
  collectedAt?: Date;
}
