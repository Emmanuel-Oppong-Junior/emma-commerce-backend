import { Field, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsDate, IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DiscountTypeEnum } from '../enums/discount-type.enum';
import { Type } from 'class-transformer';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class CreateCouponInput {
  @Field()
  @IsString()
  @MaxLength(50)
  code: string;

  @Field(() => DiscountTypeEnum)
  @IsEnum(DiscountTypeEnum)
  discountType: DiscountTypeEnum;

  @DecimalInputField()
  @IsMoneyAmount()
  value: Decimal;

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

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  minimumOrderAmount?: Decimal;
}
