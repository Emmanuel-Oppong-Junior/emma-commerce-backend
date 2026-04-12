import { Field, Float, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

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

  @Field(() => Float, { description: 'Shipping fee for this zone' })
  @IsNumber()
  @Min(0)
  fee: number;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
