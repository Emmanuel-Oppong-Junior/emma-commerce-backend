import { Field, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsDate, IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DiscountTypeEnum } from '../enums/discount-type.enum';
import { Type } from 'class-transformer';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class UpdateCouponInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @Field(() => DiscountTypeEnum, { nullable: true })
  @IsOptional()
  @IsEnum(DiscountTypeEnum)
  discountType?: DiscountTypeEnum;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  value?: Decimal;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  usageLimit?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expiresAt?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  minimumOrderAmount?: Decimal;
}
