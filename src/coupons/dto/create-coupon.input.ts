import { Field, Float, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsDate, IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DiscountTypeEnum } from '../enums/discount-type.enum';
import { Type } from 'class-transformer';

@InputType()
export class CreateCouponInput {
  @Field()
  @IsString()
  @MaxLength(50)
  code: string;

  @Field(() => DiscountTypeEnum)
  @IsEnum(DiscountTypeEnum)
  discountType: DiscountTypeEnum;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  value: number;

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

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumOrderAmount?: number;
}
