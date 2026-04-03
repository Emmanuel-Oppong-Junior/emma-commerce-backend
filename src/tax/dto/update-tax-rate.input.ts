import { Field, Float, InputType } from '@nestjs/graphql';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

@InputType()
export class UpdateTaxRateInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  country?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  region?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  rate?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
