import { Field, InputType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AttributeFilterInput, MAX_ATTRIBUTE_FILTERS } from './attribute-filter.input';
import { ProductStatusEnum } from '../enums/product.enum';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

export const SEARCH_TEXT_MAX_LENGTH = 200;

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
    description:
      'Full-text search (web-search syntax: "quoted phrase", OR, -exclude) over the name, the brand, category, ' +
      'sub-category and tag names and the descriptions; when nothing matches, names are matched allowing typos. ' +
      'Blank or punctuation-only text is ignored. At most 200 characters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TEXT_MAX_LENGTH)
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
    description:
      'Minimum price (inclusive) of an active variant, on its stored selling price (tax included; promotions and ' +
      'price lists are not applied). With priceMax, one variant must be within both bounds; above priceMax: BAD_REQUEST.',
  })
  @IsOptional()
  @IsMoneyAmount()
  priceMin?: Decimal;

  @DecimalInputField({
    nullable: true,
    description: 'Maximum price (inclusive) of an active variant, on its stored selling price (see priceMin)',
  })
  @IsOptional()
  @IsMoneyAmount()
  priceMax?: Decimal;

  @Field(() => String, {
    nullable: true,
    description: 'Filter by brand name (exact match, ignoring case)',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @Field(() => String, { nullable: true, description: 'Filter by brand ID' })
  @IsOptional()
  @IsString()
  brandId?: string;

  @Field(() => String, { nullable: true, description: 'Filter by product type ID' })
  @IsOptional()
  @IsString()
  productTypeId?: string;

  @Field(() => Boolean, {
    nullable: true,
    description:
      'true: only products with an active variant a customer can buy now (its best serving location has unreserved, ' +
      'unexpired units, like Variant.available); false: only products with none; omitted: no stock filter. With ' +
      'priceMin/priceMax and true, the same variant must be in stock and in the price range.',
  })
  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @Field(() => String, { nullable: true, description: 'Filter by tag ID (with tagName, the product needs both)' })
  @IsOptional()
  @IsString()
  tagId?: string;

  @Field(() => String, { nullable: true, description: 'Filter by tag name (exact match, ignoring case)' })
  @IsOptional()
  @IsString()
  tagName?: string;

  @Field(() => [AttributeFilterInput], {
    nullable: true,
    description:
      'Attribute filters (P6-S.2): a product matches every attribute given (AND) and any of the values of each ' +
      '(OR), on its own attributes or on an active variant. At most 10, one per key.',
  })
  @IsOptional()
  @ArrayMaxSize(MAX_ATTRIBUTE_FILTERS)
  @ValidateNested({ each: true })
  @Type(() => AttributeFilterInput)
  attributes?: AttributeFilterInput[];
}
