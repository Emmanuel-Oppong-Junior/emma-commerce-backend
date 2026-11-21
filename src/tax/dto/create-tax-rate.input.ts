import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { DecimalInputField, IsRate } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';
import { PriceChangeReasonField } from '../../price-history/dto/price-change-reason.field';

@InputType()
export class CreateTaxInput {
  @Field({ description: 'Name of the tax (e.g., "VAT", "NHIS Levy")' })
  @IsString()
  name: string;

  @DecimalInputField({ description: 'Tax rate as a decimal between 0 and 1 (e.g., 0.15 for 15%)' })
  @IsRate()
  rate: Decimal;

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @PriceChangeReasonField()
  priceChangeReason?: string;
}
