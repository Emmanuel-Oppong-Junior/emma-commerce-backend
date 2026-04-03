import { Field, Float, InputType } from '@nestjs/graphql';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

@InputType()
export class CreateTaxRateInput {
  @Field()
  @IsString()
  country: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  region?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(1)
  rate: number;

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
