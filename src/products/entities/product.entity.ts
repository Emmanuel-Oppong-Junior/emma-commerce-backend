import { Field, Float, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { Tag } from '../../tag/entities/tag.entity';
import { Discount } from '../../discount/entities/discount.entity';
import { Prisma } from '../../generated/prisma/client';
import { Category } from '../../categories/entities/category.entity';
import { SubCategory } from '../../sub-categories/entities/sub-category.entity';
import { Variant } from '../../variant/entities/variant.entity';
import { Review } from '../../review/entities/review.entity';
import { Brand } from '../../brand/entities/brand.entity';
import { CurrencyEnum, DeliveryOptionsEnum, ProductStatusEnum, StockStatusEnum } from '../enums/product.enum';

@ObjectType()
export class Product {
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

  @Field(() => Float, { description: 'Tax-inclusive display price', nullable: true })
  price?: Prisma.Decimal;

  @Field(() => Float, { description: 'Base price before taxes (admin-entered)', nullable: true })
  basePrice?: Prisma.Decimal;

  @Field(() => Float, { description: 'Current selling price after any adjustments', nullable: true })
  currentPrice?: Prisma.Decimal;

  @Field(() => CurrencyEnum, { description: 'Currency of the product price', nullable: true })
  currency?: string;

  @Field(() => Boolean, { description: 'Whether taxes are applied to this product' })
  isTaxable: boolean;

  @Field(() => String, { description: 'Stock Keeping Unit code', nullable: true })
  sku?: string;

  @Field(() => String, { description: 'Barcode (EAN, UPC, etc.)', nullable: true })
  barcode?: string;

  @Field(() => Int, { description: 'Available stock quantity' })
  quantity: number;

  @Field(() => StockStatusEnum, { description: 'Current stock availability status', nullable: true })
  stockStatus?: string;

  @Field(() => Int, { description: 'Quantity threshold that triggers a low-stock alert', nullable: true })
  lowStockAlert?: number;

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

  @Field(() => Float, { description: 'Discounted price, if a discount is active', nullable: true })
  discountedPrice?: number;

  @Field(() => Discount, { description: 'Active discount applied to the product', nullable: true })
  appliedDiscount?: Discount;

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

  @Field(() => [Variant], { nullable: true })
  variants?: Variant[];

  @Field(() => [Discount], { nullable: true })
  discounts?: Discount[];

  @Field(() => [Review], { nullable: true })
  reviews?: Review[];

  @Field(() => [Tag], { nullable: true })
  tags?: Tag[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
