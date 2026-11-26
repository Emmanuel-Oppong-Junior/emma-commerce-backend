import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { SerialFormat } from '../../inventory/serials/entities/serial-unit.entity';
import { Tag } from '../../tag/entities/tag.entity';
import { Category } from '../../categories/entities/category.entity';
import { SubCategory } from '../../sub-categories/entities/sub-category.entity';
import { Variant } from '../../variant/entities/variant.entity';
import { Review } from '../../review/entities/review.entity';
import { Brand } from '../../brand/entities/brand.entity';
import {
  CurrencyEnum,
  DeliveryOptionsEnum,
  FulfilmentKindEnum,
  ProductStatusEnum,
  UnitOfMeasureEnum,
} from '../enums/product.enum';
import { PriceRange } from './price-range.entity';
import { GraphQLJSONObject } from 'graphql-type-json';
import { ProductType } from '../../product-types/entities/product-type.entity';
import { SeoFields } from '../../seo/entities/seo-fields.entity';

@ObjectType()
export class Product extends SeoFields {
  @Field(() => ID, { description: 'Unique identifier of the product' })
  id: string;

  @Field(() => String, { description: 'Name of the product' })
  name: string;

  @Field(() => String, { description: 'Full description of the product', nullable: true })
  description?: string;

  @Field(() => String, { description: 'Short marketing description (max 500 chars)', nullable: true })
  shortDescription?: string;

  @Field(() => [String], { description: 'Array of image URLs', nullable: true })
  images: string[];

  @Field(() => [String], { description: 'Downloadable or supplementary file URLs', nullable: true })
  attachments?: string[];

  @Field(() => CurrencyEnum, { description: 'Currency of the product price', nullable: true })
  currency?: string;

  @Field(() => Boolean, { description: 'Whether variant prices add tax to their basePrice' })
  isTaxable: boolean;

  @Field(() => Boolean, { description: 'Whether the product is visible to customers', defaultValue: false })
  isActive: boolean;

  @Field(() => ProductStatusEnum, { description: 'Publishing lifecycle status', nullable: true })
  status?: string;

  @Field(() => GraphQLISODateTime, { description: 'When the product was published', nullable: true })
  publishedAt?: Date;

  @Field(() => [DeliveryOptionsEnum], { description: 'Available delivery methods for this product', nullable: true })
  deliveryOptions?: string[];

  @Field(() => [String], { description: 'Region names when deliveryOptions includes SELECTED_REGIONS', nullable: true })
  selectedDeliveryRegions?: string[];

  @Field(() => GraphQLISODateTime, { description: 'Expiry or best-before date', nullable: true })
  expiryDate?: Date;

  @Field(() => ID, { description: 'ID of the product type' })
  productTypeId: string;

  @Field(() => ProductType, { description: 'The product type, whose attribute definitions describe attributes' })
  productType?: ProductType;

  @Field(() => GraphQLJSONObject, {
    description: "Values of the product type's non-axis attributes, keyed by attribute key",
  })
  attributes: Record<string, unknown>;

  @Field(() => Boolean, { description: 'Sold only against a prescription (pharmacy; enforced in a later phase)' })
  requiresPrescription: boolean;

  @Field(() => Boolean, { description: 'Perishable goods (expiry tracking comes with the inventory ledger)' })
  isPerishable: boolean;

  @Field(() => Int, { description: 'Shelf life in days for perishable goods', nullable: true })
  shelfLifeDays?: number | null;

  @Field(() => Boolean, { description: 'Stock is tracked per lot/batch (inventory ledger, later phase)' })
  trackLots: boolean;

  @Field(() => Boolean, { description: 'Each unit carries a serial number such as an IMEI (later phase)' })
  trackSerials: boolean;

  @Field(() => SerialFormat, { description: 'How serials of this product are checked (P4-D.1)' })
  serialFormat: SerialFormat;

  @Field(() => Int, { nullable: true, description: 'Warranty of each serialised unit from delivery, in months' })
  warrantyMonths?: number | null;

  @Field(() => FulfilmentKindEnum, { description: 'How the product reaches the customer' })
  fulfilmentKind: FulfilmentKindEnum;

  @Field(() => UnitOfMeasureEnum, { description: 'Unit the product is sold in' })
  unitOfMeasure: UnitOfMeasureEnum;

  @Field(() => String, { nullable: true })
  categoryId?: string;

  @Field(() => Category, { nullable: true })
  category?: Category;

  @Field(() => String, { nullable: true })
  subcategoryId?: string;

  @Field(() => SubCategory, { nullable: true })
  subcategory?: SubCategory;

  @Field(() => String, { nullable: true })
  brandId?: string;

  @Field(() => Brand, { nullable: true })
  brand?: Brand;

  @Field(() => [Variant], { description: 'The active variants (SKUs)' })
  variants?: Variant[];

  @Field(() => PriceRange, { nullable: true })
  priceRange?: PriceRange | null;

  @Field(() => Int)
  totalStock?: number;

  @Field(() => Boolean)
  inStock?: boolean;

  @Field(() => [Review], { nullable: true })
  reviews?: Review[];

  @Field(() => [Tag], { nullable: true })
  tags?: Tag[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
