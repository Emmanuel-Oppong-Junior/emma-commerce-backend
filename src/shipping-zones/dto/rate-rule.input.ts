import { Field, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { DeliveryServiceLevel } from '../enums/delivery.enums';

const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({ description: 'From fromGrams of cart weight up, the rule charges fee instead of its base fee' })
export class WeightBandInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  fromGrams: number;

  @DecimalInputField()
  @IsMoneyAmount()
  fee: Decimal;
}

@InputType()
export class CreateRateRuleInput {
  @Field(() => DeliveryServiceLevel)
  @IsEnum(DeliveryServiceLevel)
  serviceLevel: DeliveryServiceLevel;

  @DecimalInputField({ description: 'Fee below every weight band' })
  @IsMoneyAmount()
  baseFee: Decimal;

  @DecimalInputField({
    nullable: true,
    description: 'Delivery is free once the merchandise total after promotions (tax included) reaches this',
  })
  @IsOptional()
  @IsMoneyAmount()
  freeAbove?: Decimal | null;

  @Field(() => [WeightBandInput], {
    nullable: true,
    defaultValue: [],
    description: 'Ascending in weight, never cheaper than the band below or the base fee',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeightBandInput)
  weightBands?: WeightBandInput[];

  @Field({ nullable: true, defaultValue: true, description: 'At most one active rule per zone and service level' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType({ description: 'Rate rule fields to change; omitted fields keep their value, null clears freeAbove' })
export class UpdateRateRuleInput {
  @DecimalInputField({ nullable: true })
  @unlessOmitted
  @IsMoneyAmount()
  baseFee?: Decimal;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  freeAbove?: Decimal | null;

  @Field(() => [WeightBandInput], { nullable: true, description: 'Replaces every weight band' })
  @unlessOmitted
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeightBandInput)
  weightBands?: WeightBandInput[];

  @Field({ nullable: true })
  @unlessOmitted
  @IsBoolean()
  isActive?: boolean;
}
