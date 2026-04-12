import { Field, Float, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

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

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
