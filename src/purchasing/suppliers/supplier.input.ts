import { ArgsType, Field, ID, InputType, Int, PartialType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Currency } from '../../generated/prisma/client';
import { CurrencyEnum } from '../../products/enums/product.enum';

@InputType()
export class CreateSupplierInput {
  @Field({ description: 'Unique ignoring case' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field(() => CurrencyEnum, { nullable: true, description: 'Defaults to the store currency, the only one allowed' })
  @IsOptional()
  @IsEnum(CurrencyEnum)
  currency?: Currency;

  @Field({ nullable: true, description: 'Defaults to true on creation' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType()
export class UpdateSupplierInput extends PartialType(CreateSupplierInput) {}

@ArgsType()
export class SuppliersArgs {
  @Field({ nullable: true, description: 'Only active (true) or inactive (false) suppliers' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Part of the name, contact name, email or phone, ignoring case' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last supplier of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
