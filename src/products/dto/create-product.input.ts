import { Field, GraphQLISODateTime, InputType, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CurrencyEnum, DeliveryOptionsEnum, ProductStatusEnum, StockStatusEnum } from '../enums/product.enum';

@InputType()
export class CreateProductInput {
  @Field(() => String, { description: 'Product name (e.g., "Cotton T-Shirt")' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'Product name is required' })
  @Length(1, 255, { message: 'Product name must be between 1 and 255 characters' })
  name: string;

  @Field(() => String, { nullable: true, description: 'Full product description (max 5000 characters)' })
  @IsOptional()
  @Length(0, 5000, { message: 'Description must not exceed 5000 characters' })
  description?: string;

  @Field(() => String, { nullable: true, description: 'Short marketing description (max 500 characters)' })
  @IsOptional()
  @MaxLength(500, { message: 'Short description must not exceed 500 characters' })
  shortDescription?: string;

  @Field(() => [String], { nullable: true, description: 'HTTPS URLs to product images (max 10)' })
  @IsOptional()
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { each: true, message: 'Each image must be a valid HTTPS URL' },
  )
  @ArrayMaxSize(10, { message: 'Product cannot have more than 10 images' })
  images?: string[];

  @Field(() => [String], { nullable: true, description: 'URLs to downloadable attachments or spec sheets' })
  @IsOptional()
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { each: true, message: 'Each attachment must be a valid HTTPS URL' },
  )
  attachments?: string[];

  @Field(() => String, {
    description: 'Base price before taxes — decimal string (e.g., "29.99")',
  })
  @IsNotEmpty({ message: 'Base price is required' })
  @IsNumberString({}, { message: 'Base price must be a valid decimal string (e.g., "29.99")' })
  basePrice: string;

  @Field(() => Boolean, { description: 'Whether taxes apply to this product', defaultValue: false })
  @IsBoolean()
  isTaxable: boolean = false;

  @Field(() => CurrencyEnum, { nullable: true, description: 'Currency for the product price (defaults to GHS)' })
  @IsOptional()
  @IsEnum(CurrencyEnum, { message: 'currency must be a valid Currency value' })
  currency?: CurrencyEnum;

  @Field(() => String, { nullable: true, description: 'SKU code (e.g., "TSHIRT-XL")' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 50, { message: 'SKU must be between 1 and 50 characters' })
  @Matches(/^[a-zA-Z0-9\-]+$/, { message: 'SKU can only contain letters, numbers, and hyphens' })
  sku?: string;

  @Field(() => String, { nullable: true, description: 'Barcode (EAN, UPC, GTIN, etc.)' })
  @IsOptional()
  @IsString()
  @Length(1, 100, { message: 'Barcode must be between 1 and 100 characters' })
  barcode?: string;

  @Field(() => Int, { description: 'Initial stock quantity (0 or more)' })
  @IsInt({ message: 'Quantity must be an integer' })
  @Min(0, { message: 'Quantity cannot be negative' })
  quantity: number;

  @Field(() => StockStatusEnum, { nullable: true, description: 'Stock availability status (defaults to IN_STOCK)' })
  @IsOptional()
  @IsEnum(StockStatusEnum, { message: 'stockStatus must be a valid StockStatus value' })
  stockStatus?: StockStatusEnum;

  @Field(() => Int, {
    nullable: true,
    description: 'Quantity threshold that triggers a low-stock alert (defaults to 5)',
  })
  @IsOptional()
  @IsInt({ message: 'Low stock alert must be an integer' })
  @Min(0, { message: 'Low stock alert cannot be negative' })
  @Max(10000)
  lowStockAlert?: number;

  @Field(() => Boolean, { description: 'Whether the product is visible to customers', defaultValue: false })
  @IsBoolean()
  isActive: boolean = false;

  @Field(() => ProductStatusEnum, { nullable: true, description: 'Publishing lifecycle status (defaults to DRAFT)' })
  @IsOptional()
  @IsEnum(ProductStatusEnum, { message: 'status must be a valid ProductStatus value' })
  status?: ProductStatusEnum;

  @Field(() => [DeliveryOptionsEnum], { nullable: true, description: 'Delivery methods available for this product' })
  @IsOptional()
  @IsEnum(DeliveryOptionsEnum, { each: true, message: 'Each delivery option must be a valid DeliveryOptions value' })
  deliveryOptions?: DeliveryOptionsEnum[];

  @Field(() => [String], { nullable: true, description: 'Region names when deliveryOptions includes SELECTED_REGIONS' })
  @IsOptional()
  @IsString({ each: true })
  selectedDeliveryRegions?: string[];

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'Expiry or best-before date for perishable products',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'expiryDate must be a valid date' })
  expiryDate?: Date;

  @Field(() => String, { nullable: true, description: 'ID of the parent category' })
  @IsOptional()
  categoryId?: string;

  @Field(() => String, { nullable: true, description: 'ID of the subcategory' })
  @IsOptional()
  subcategoryId?: string;

  @Field(() => String, { nullable: true, description: 'ID of the brand' })
  @IsOptional()
  brandId?: string;
}
