import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { OrderLineTax } from './order-line-tax.entity';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { Variant } from '../../variant/entities/variant.entity';
import { GraphQLJSONObject } from 'graphql-type-json';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { COST_VIEWERS_ONLY } from '../../purchasing/cost/cost-visibility';

@ObjectType()
export class OrderItem {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ID)
  productId: string;

  @Field(() => ID, { description: 'The variant (SKU) ordered' })
  variantId: string;

  @Field(() => String, {
    nullable: true,
    description: 'SKU when ordered (null on lines ordered before variants were sold)',
  })
  sku?: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true, description: 'Option values when ordered, e.g. { size: "M" }' })
  optionValues?: Record<string, unknown> | null;

  @Field(() => Int)
  quantity: number;

  @Field({ description: 'Product name when ordered (older orders: the name when they were migrated)' })
  productName: string;

  @Field(() => MoneyObject, { description: 'Catalogue price of one unit when ordered, tax included' })
  unitListPrice: Decimal;

  @Field(() => MoneyObject, { description: 'Product discount taken off one unit' })
  unitDiscount: Decimal;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'One unit after its discount, without tax; null on orders placed before tax was recorded',
  })
  unitNet?: Decimal | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Tax included in one discounted unit; null on orders placed before tax was recorded',
  })
  unitTax?: Decimal | null;

  @Field(() => MoneyObject, { description: '(unitListPrice - unitDiscount) x quantity, tax included' })
  lineTotal: Decimal;

  @Field(() => GraphQLDecimal, {
    ...COST_VIEWERS_ONLY,
    description:
      "The variant's unit cost (tax-exclusive, 4 dp) when the sale's stock was consumed; null when unknown or not " +
      'sold yet. Never changes afterwards (inventory.cost.view)',
  })
  unitCost?: Decimal | null;

  @Field(() => [OrderLineTax], { description: 'Taxes included in the line; empty on orders placed before' })
  taxLines: OrderLineTax[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => Product)
  product: Product;

  @Field(() => Variant)
  variant: Variant;
}
