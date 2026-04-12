import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class CreatePickupLocationInput {
  @Field({ description: 'Display name of the pickup location' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @Field({ description: 'Street address' })
  @IsString()
  @IsNotEmpty()
  address: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  city: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  state: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  country: string;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
