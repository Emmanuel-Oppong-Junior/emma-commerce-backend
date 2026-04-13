import { Field, Float, InputType } from '@nestjs/graphql';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

@InputType()
export class CreateTaxInput {
  @Field({ description: 'Name of the tax (e.g., "VAT", "NHIS Levy")' })
  @IsString()
  name: string;

  @Field(() => Float, { description: 'Tax rate as a decimal between 0 and 1 (e.g., 0.15 for 15%)' })
  @IsNumber()
  @Min(0)
  @Max(1)
  rate: number;

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
