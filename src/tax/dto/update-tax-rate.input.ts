import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { DecimalInputField, IsRate } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class UpdateTaxInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @DecimalInputField({ nullable: true })
  @IsOptional()
  @IsRate()
  rate?: Decimal;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
