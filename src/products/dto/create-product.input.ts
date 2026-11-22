import { Field, GraphQLISODateTime, InputType, Int } from '@nestjs/graphql';
import { SerialFormat } from '../../inventory/serials/entities/serial-unit.entity';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  CurrencyEnum,
  DeliveryOptionsEnum,
  FulfilmentKindEnum,
  ProductStatusEnum,
  UnitOfMeasureEnum,
} from '../enums/product.enum';
import { GraphQLJSONObject } from 'graphql-type-json';
import { VariantFieldsInput } from '../../variant/dto/create-variant.input';

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

  @Field(() => [VariantFieldsInput], {
    description: 'The variants (SKUs) to sell, at least one; a product without options has one, with no optionValues',
  })
  @ArrayMinSize(1, { message: 'A product needs at least one variant' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariantFieldsInput)
  variants: VariantFieldsInput[];

  @Field(() => Boolean, { description: 'Whether variant prices add tax to their basePrice', defaultValue: false })
  @IsBoolean()
  isTaxable: boolean = false;

  @Field(() => CurrencyEnum, { nullable: true, description: 'Currency for the product price (defaults to GHS)' })
  @IsOptional()
  @IsEnum(CurrencyEnum, { message: 'currency must be a valid Currency value' })
  currency?: CurrencyEnum;

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

  @Field(() => String, { nullable: true, description: 'ID of the product type (defaults to General)' })
  @IsOptional()
  @IsString()
  productTypeId?: string;

  @Field(() => GraphQLJSONObject, {
    nullable: true,
    description: 'Values for the product type\'s non-axis attributes, e.g. { "material": "Cotton" }',
  })
  @IsOptional()
  attributes?: Record<string, unknown>;

  @Field(() => Boolean, { nullable: true, description: 'Sold only against a prescription (defaults to false)' })
  @IsOptional()
  @IsBoolean()
  requiresPrescription?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Perishable goods (defaults to false)' })
  @IsOptional()
  @IsBoolean()
  isPerishable?: boolean;

  @Field(() => Int, { nullable: true, description: 'Shelf life in days for perishable goods (1-3650)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  shelfLifeDays?: number;

  @Field(() => Boolean, { nullable: true, description: 'Track stock per lot/batch (defaults to false)' })
  @IsOptional()
  @IsBoolean()
  trackLots?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Track a serial number per unit (defaults to false)' })
  @IsOptional()
  @IsBoolean()
  trackSerials?: boolean;

  @Field(() => SerialFormat, {
    nullable: true,
    description: 'How serials are checked when the product tracks them: FREE_TEXT (default) or IMEI (15 digits, Luhn)',
  })
  @IsOptional()
  @IsEnum(SerialFormat)
  serialFormat?: SerialFormat;

  @Field(() => Int, {
    nullable: true,
    description: 'Warranty of each serialised unit from delivery, in months (1-120); omit for no warranty',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  warrantyMonths?: number | null;

  @Field(() => FulfilmentKindEnum, { nullable: true, description: 'Defaults to PHYSICAL' })
  @IsOptional()
  @IsEnum(FulfilmentKindEnum)
  fulfilmentKind?: FulfilmentKindEnum;

  @Field(() => UnitOfMeasureEnum, { nullable: true, description: 'Defaults to EACH' })
  @IsOptional()
  @IsEnum(UnitOfMeasureEnum)
  unitOfMeasure?: UnitOfMeasureEnum;

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
