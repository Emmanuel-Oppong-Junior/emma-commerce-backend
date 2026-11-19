import { Field, ID, InputType } from '@nestjs/graphql';
import { IsOptional, IsString } from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class ApproveReturnInput {
  @Field(() => ID)
  @IsString()
  returnRequestId: string;

  @DecimalInputField()
  @IsMoneyAmount()
  refundAmount: Decimal;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  adminNote?: string;
}

@InputType()
export class RejectReturnInput {
  @Field(() => ID)
  @IsString()
  returnRequestId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  adminNote?: string;
}
