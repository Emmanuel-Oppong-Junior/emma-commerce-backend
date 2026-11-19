import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { ProductStatusEnum } from '../enums/product.enum';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class ProductFilterArgs {
  @Field(() => String, { nullable: true, description: 'Filter by category ID' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @Field(() => String, { nullable: true, description: 'Filter by category name' })
  @IsOptional()
  @IsString()
  categoryName?: string;

  @Field(() => String, { nullable: true, description: 'Filter by subcategory name' })
  @IsOptional()
  @IsString()
  subCategoryName?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Filter by subcategory ID',
  })
  @IsOptional()
  @IsString()
  subcategoryId?: string;

  @Field(() => ProductStatusEnum, {
    nullable: true,
    description: 'Filter by publishing status (admin queries only; public queries always return PUBLISHED)',
  })
  @IsOptional()
  @IsEnum(ProductStatusEnum)
  status?: ProductStatusEnum;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Filter by active status',
    defaultValue: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Filter by name, description, or tags (partial match)',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Filter products created after this ISO date',
  })
  @IsOptional()
  @IsDateString()
  createdAfter?: string;

  @DecimalInputField({
    nullable: true,
    description: 'Filter by minimum price (inclusive)',
  })
  @IsOptional()
  @IsMoneyAmount()
  priceMin?: Decimal;

  @DecimalInputField({
    nullable: true,
    description: 'Filter by maximum price (inclusive)',
  })
  @IsOptional()
  @IsMoneyAmount()
  priceMax?: Decimal;

  @Field(() => String, {
    nullable: true,
    description: 'Filter by brand name (exact match)',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Filter by instock status',
  })
  @IsOptional()
  inStock?: boolean;

  @Field(() => String, { nullable: true, description: 'Filter by tag ID' })
  @IsOptional()
  @IsString()
  tagId?: string;

  @Field(() => String, { nullable: true, description: 'Filter by tag name' })
  @IsOptional()
  @IsString()
  tagName?: string;
}
