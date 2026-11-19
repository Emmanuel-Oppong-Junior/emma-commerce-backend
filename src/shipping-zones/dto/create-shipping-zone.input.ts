import { Field, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class CreateShippingZoneInput {
  @Field({ description: 'Unique name for this shipping zone' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @Field(() => [String], { description: 'Cities covered by this zone' })
  @IsArray()
  @IsString({ each: true })
  cities: string[];

  @DecimalInputField({ description: 'Shipping fee for this zone' })
  @IsMoneyAmount()
  fee: Decimal;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
