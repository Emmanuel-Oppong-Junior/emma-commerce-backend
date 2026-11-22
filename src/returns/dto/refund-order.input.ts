import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { RefundReason } from '../enums/refund-reason.enum';

@InputType()
export class RefundOrderLineInput {
  @Field(() => ID)
  @IsString()
  orderItemId: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;
}

@InputType()
export class RefundOrderInput {
  @Field(() => ID)
  @IsString()
  orderId: string;

  @Field({
    description:
      'Chosen by the client for this refund (8-100 letters, digits, "-" or "_"). Sending the same key again returns ' +
      'the refund it recorded instead of refunding twice',
  })
  @Matches(/^[A-Za-z0-9_-]{8,100}$/, { message: 'idempotencyKey must be 8-100 letters, digits, "-" or "_"' })
  idempotencyKey: string;

  @Field(() => [RefundOrderLineInput], {
    nullable: true,
    description: 'Order line units to refund, at what the order stored for them',
  })
  @IsOptional()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RefundOrderLineInput)
  lines?: RefundOrderLineInput[];

  @Field({ nullable: true, description: 'Also refund the delivery fee the order was charged (once per order)' })
  @IsOptional()
  @IsBoolean()
  shipping?: boolean;

  @DecimalInputField({ nullable: true, description: 'A free amount on top of the lines and the delivery fee' })
  @IsOptional()
  @IsMoneyAmount({ positive: true })
  amount?: Decimal;

  @Field(() => RefundReason)
  @IsEnum(RefundReason)
  reason: RefundReason;

  @Field({ nullable: true, description: 'Internal note, never shown to the customer; required when reason is OTHER' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
