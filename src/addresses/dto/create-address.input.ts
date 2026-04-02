import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class CreateAddressInput {
  @Field({ description: 'Street address' })
  @IsNotEmpty({ message: 'Street must not be empty' })
  @IsString({ message: 'Street must be a string' })
  @MaxLength(255, { message: 'Street must not exceed 255 characters' })
  street: string;

  @Field({ description: 'City' })
  @IsNotEmpty({ message: 'City must not be empty' })
  @IsString({ message: 'City must be a string' })
  @MaxLength(100, { message: 'City must not exceed 100 characters' })
  city: string;

  @Field({ description: 'State or province' })
  @IsNotEmpty({ message: 'State must not be empty' })
  @IsString({ message: 'State must be a string' })
  @MaxLength(100, { message: 'State must not exceed 100 characters' })
  state: string;

  @Field({ description: 'ZIP or postal code' })
  @IsNotEmpty({ message: 'Zip code must not be empty' })
  @IsString({ message: 'Zip code must be a string' })
  @MaxLength(20, { message: 'Zip code must not exceed 20 characters' })
  zipCode: string;

  @Field({ description: 'Country (full name or ISO 3166-1 alpha-2 code)' })
  @IsNotEmpty({ message: 'Country must not be empty' })
  @IsString({ message: 'Country must be a string' })
  @MaxLength(100, { message: 'Country must not exceed 100 characters' })
  country: string;
}
