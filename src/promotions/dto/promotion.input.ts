import { Field, GraphQLISODateTime, ID, InputType, Int } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PromotionScope, PromotionType } from '../../generated/prisma/client';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';

const MAX_TARGETS = 1000;

@InputType({ description: 'A new promotion; it starts inactive unless isActive is true' })
export class CreatePromotionInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @Field(() => PromotionScope)
  @IsEnum(PromotionScope)
  scope: PromotionScope;

  @Field(() => PromotionType)
  @IsEnum(PromotionType)
  type: PromotionType;

  @DecimalInputField({ description: 'A percentage, 0 to 100 (PERCENT), or an amount in the store currency' })
  @IsMoneyAmount()
  value: Decimal;

  @Field(() => [ID], {
    defaultValue: [],
    description: "Ids of the scope's kind: variants (SKU), products, categories or brands; none for CART",
  })
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsString({ each: true })
  targetIds: string[] = [];

  @DecimalInputField({ nullable: true, description: 'Least merchandise total the order needs' })
  @IsOptional()
  @IsMoneyAmount()
  minimumSpend?: Decimal | null;

  @Field(() => Int, { nullable: true, description: 'Least number of targeted units (any unit for CART)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minimumQuantity?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Defaults to now' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startsAt?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null for open-ended' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endsAt?: Date | null;

  @Field({ defaultValue: false })
  @IsBoolean()
  isActive: boolean = false;

  @Field(() => Int, { defaultValue: 0, description: 'Lowest number wins a tie between equal savings' })
  @IsInt()
  priority: number = 0;

  @Field({ defaultValue: 'default' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  stackingGroup: string = 'default';

  @Field({ defaultValue: false })
  @IsBoolean()
  exclusive: boolean = false;

  @Field({ defaultValue: false, description: 'Only orders entering one of its coupon codes get it' })
  @IsBoolean()
  requiresCoupon: boolean = false;

  @Field(() => Int, { nullable: true, description: 'Orders that may use it, across all customers' })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;

  @Field(() => Int, { nullable: true, description: 'Orders each customer may use it on' })
  @IsOptional()
  @IsInt()
  @Min(1)
  perCustomerLimit?: number | null;
}

@InputType({
  description:
    'Changes to a promotion: omitted fields stay as they are, null clears an optional one. targetIds, when given, ' +
    'replaces every target (an empty list clears them); it is required when the scope changes.',
})
export class UpdatePromotionInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @Field(() => PromotionScope, { nullable: true })
  @IsOptional()
  @IsEnum(PromotionScope)
  scope?: PromotionScope;

  @Field(() => PromotionType, { nullable: true })
  @IsOptional()
  @IsEnum(PromotionType)
  type?: PromotionType;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  value?: Decimal;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsString({ each: true })
  targetIds?: string[];

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  minimumSpend?: Decimal | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  minimumQuantity?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startsAt?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endsAt?: Date | null;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  priority?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  stackingGroup?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  exclusive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresCoupon?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  perCustomerLimit?: number | null;
}
