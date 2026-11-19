import { Field, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class UpdateShippingZoneInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @Field(() => [String], { nullable: true, description: 'Replaces the entire cities list' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cities?: string[];

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsMoneyAmount()
  fee?: Decimal;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
