import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Length, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { GraphQLJSONObject } from 'graphql-type-json';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

export const MAX_STOCK_QUANTITY = 1_000_000;
const MAX_SIZE = 1_000_000;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The fields of one variant (SKU); shared by createVariant and createProduct's variants. */
@InputType()
export class VariantFieldsInput {
  @Field(() => GraphQLJSONObject, {
    nullable: true,
    description: 'Values for the product type\'s variant axes, e.g. { "size": "M", "colour": "Red" }; omit for none',
  })
  @IsOptional()
  optionValues?: Record<string, unknown>;

  @DecimalInputField({
    description: 'Price before tax, e.g. "29.99"; the selling price adds tax when the product is taxable',
  })
  @IsMoneyAmount()
  basePrice: Decimal;

  @Field(() => Int, {
    description:
      'Opening stock at the default location, recorded as a RECEIPT; later changes go through restock/adjust',
  })
  @IsInt({ message: 'quantity must be an integer' })
  @Min(0)
  @Max(MAX_STOCK_QUANTITY)
  quantity: number;

  @Field(() => String, { nullable: true, description: 'Unique SKU code; generated when omitted' })
  @IsOptional()
  @Transform(trim)
  @Length(1, 50)
  @Matches(/^[a-zA-Z0-9-]+$/, { message: 'sku can only contain letters, numbers and hyphens' })
  sku?: string;

  @Field(() => String, { nullable: true, description: 'Unique barcode (EAN, UPC, GTIN, ...)' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 100)
  barcode?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SIZE)
  weightGrams?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE)
  lengthMm?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE)
  widthMm?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SIZE)
  heightMm?: number;

  @Field(() => String, { nullable: true, description: 'HTTPS image shown for this variant' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'image must be a valid HTTPS URL' })
  image?: string;

  @Field(() => Int, { nullable: true, description: 'Stock level that counts as low (defaults to 5)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  lowStockThreshold?: number;
}

@InputType()
export class CreateVariantInput extends VariantFieldsInput {
  @Field(() => ID, { description: 'ID of the product' })
  @IsNotEmpty({ message: 'Product ID must not be empty' })
  productId: string;

  @Field(() => ID, { nullable: true, description: 'ID of a discount on this variant' })
  @IsOptional()
  @IsString()
  discountId?: string;
}
