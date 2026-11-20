import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';
import { GraphQLJSONObject } from 'graphql-type-json';

@ObjectType()
export class Variant {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true, description: 'Stock keeping unit code' })
  sku?: string | null;

  @Field(() => String, { nullable: true, description: 'Barcode (EAN, UPC, GTIN, ...)' })
  barcode?: string | null;

  @Field(() => GraphQLJSONObject, {
    description: 'Values for the product type\'s variant axes, e.g. { size: "M", colour: "Red" }',
  })
  optionValues: Record<string, unknown>;

  @Field(() => Int, {
    nullable: true,
    description: 'Available stock at or below which an inventory.low_stock event is raised (default 5)',
  })
  lowStockThreshold?: number | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description:
      'Selling price: basePrice, plus tax when the product is taxable; null only for an unpriced migrated variant',
  })
  price: Decimal | null;

  @Field(() => MoneyObject, { nullable: true, description: 'Price before tax, as entered by an admin' })
  basePrice?: Decimal | null;

  @Field({ description: 'Inactive variants are archived: kept for history, never sold' })
  isActive: boolean;

  @Field(() => Int, { nullable: true })
  weightGrams?: number | null;

  @Field(() => Int, { nullable: true })
  lengthMm?: number | null;

  @Field(() => Int, { nullable: true })
  widthMm?: number | null;

  @Field(() => Int, { nullable: true })
  heightMm?: number | null;

  @Field(() => String, { nullable: true, description: 'Image shown for this variant instead of the product images' })
  image?: string | null;

  @Field(() => ID)
  productId: string;

  @Field(() => Product)
  product: Product;

  @Field(() => ID, { nullable: true })
  discountId?: string;
}
