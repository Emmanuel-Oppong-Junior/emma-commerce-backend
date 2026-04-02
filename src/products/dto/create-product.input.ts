import { Field, InputType, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsUrl,
  Length,
  Matches,
  Min,
  IsNumberString,
} from 'class-validator';
import { Transform } from 'class-transformer';

@InputType()
export class CreateProductInput {
  @Field(() => String, {
    description: 'Name of the product (e.g., "Cotton T-Shirt")',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'Product name is required' })
  @Length(1, 255, {
    message: 'Product name must be between 1 and 255 characters',
  })
  name: string;

  @Field(() => [String], {
    nullable: true,
    description: 'Array of HTTPS URLs to product images (max 10)',
  })
  @IsOptional()
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { each: true, message: 'Each image must be a valid HTTPS URL' },
  )
  @ArrayMaxSize(10, { message: 'Product cannot have more than 10 images' })
  images?: string[];

  @Field(() => String, {
    nullable: true,
    description: 'Optional description of the product (max 1000 characters)',
  })
  @IsOptional()
  @Length(0, 5000, { message: 'Description must not exceed 5000 characters' })
  description?: string;

  @Field(() => String, {
    description: 'Price of the product in default currency — pass as a decimal string (e.g., "29.99") to avoid floating-point rounding errors',
  })
  @IsNotEmpty({ message: 'Price is required' })
  @IsNumberString({}, { message: 'Price must be a valid decimal string (e.g., "29.99")' })
  @Min(0, { message: 'Price must be non-negative' })
  price: string;

  @Field(() => String, {
    nullable: true,
    description: 'Optional Stock Keeping Unit (SKU) code (e.g., "TSHIRT-XL")',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 50, { message: 'SKU must be between 1 and 50 characters' })
  @Matches(/^[a-zA-Z0-9\-]+$/, {
    message: 'SKU can only contain letters, numbers, and hyphens',
  })
  sku?: string;

  @Field(() => Int, { description: 'Available stock quantity (e.g., 100)' })
  @IsNotEmpty({ message: 'Quantity is required' })
  @IsPositive({ message: 'Quantity must be positive' })
  quantity: number;

  @Field(() => Boolean, {
    description: 'Whether the product is active and visible (defaults to false)',
    defaultValue: false,
  })
  @IsBoolean()
  isActive: boolean = false;

  @Field(() => String, {
    description: 'ID of the parent category (e.g., "cat_clothing")',
  })
  @IsNotEmpty({ message: 'Category ID is required' })
  categoryId?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Optional ID of the subcategory (e.g., "sub_shirts")',
  })
  @IsOptional()
  subcategoryId?: string;

  @Field(() => String, { nullable: true, description: 'Optional brand name (e.g., "Nike")' })
  @IsOptional()
  brandId?: string;
}
