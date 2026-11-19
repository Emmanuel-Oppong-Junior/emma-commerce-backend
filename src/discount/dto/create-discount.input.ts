import { Field, GraphQLISODateTime, ID, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsDate, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { DiscountType } from '../enums/discount-type.enum';
import { IsEndDateAfterStartDate } from '../../commons/validators/is-end-date-after-start-date.validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class CreateDiscountInput {
  @Field(() => String, { description: 'The name of the discount (e.g., "Summer Sale 2025")' })
  @IsNotEmpty({ message: 'Discount name is required' })
  @IsString({ message: 'Discount name must be a string' })
  name: string;

  @Field(() => String, { description: 'A detailed description of the discount', nullable: true })
  @IsOptional()
  @IsString({ message: 'Discount description must be a string' })
  description?: string;

  @Field(() => DiscountType, { description: 'The type of discount (e.g., PERCENTAGE or FIXED_AMOUNT)' })
  @IsNotEmpty({ message: 'Discount type is required' })
  @IsEnum(DiscountType, { message: 'Discount type must be a valid enum value' })
  type: DiscountType;

  @DecimalInputField({ description: 'The discount value (e.g., 20 for 20% or 10.00 for $10 off)' })
  @IsMoneyAmount({ positive: true })
  value: Decimal;

  @Field(() => GraphQLISODateTime, { description: 'The start date and time of the discount' })
  @IsNotEmpty({ message: 'Start date is required' })
  @IsDate({ message: 'Start date must be a valid date' })
  @Type(() => Date)
  startDate: Date;

  @Field(() => GraphQLISODateTime, { description: 'The end date and time of the discount' })
  @IsNotEmpty({ message: 'End date is required' })
  @IsDate({ message: 'End date must be a valid date' })
  @IsEndDateAfterStartDate('startDate', { message: 'endDate must be after startDate' })
  @Type(() => Date)
  endDate: Date;

  @Field(() => Boolean, { description: 'Whether the discount is active', defaultValue: false })
  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive: boolean;

  @Transform(({ value }) => value ?? [])
  @Field(() => [ID], {
    description: 'List of product IDs to which the discount applies',
    nullable: true,
    defaultValue: [],
  })
  @IsOptional()
  @IsArray({ message: 'Products must be an array of IDs' })
  products: string[];

  @Transform(({ value }) => value ?? [])
  @Field(() => [ID], {
    description: 'List of variant IDs to which the discount applies',
    nullable: true,
    defaultValue: [],
  })
  @IsOptional()
  @IsArray({ message: 'Variants must be an array of IDs' })
  variants: string[];

  @Transform(({ value }) => value ?? [])
  @Field(() => [ID], {
    description: 'List of category IDs to which the discount applies',
    nullable: true,
    defaultValue: [],
  })
  @IsOptional()
  @IsArray({ message: 'Categories must be an array of IDs' })
  categories: string[];

  @DecimalInputField({ description: 'Minimum purchase amount to qualify for the discount', nullable: true })
  @IsOptional()
  @IsMoneyAmount({ positive: true })
  minimumPurchase?: Decimal;
}
