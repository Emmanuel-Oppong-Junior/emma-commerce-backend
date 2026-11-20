import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { Discount } from '../../discount/entities/discount.entity';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { Variant } from '../../variant/entities/variant.entity';
import { GraphQLJSONObject } from 'graphql-type-json';

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

  @Field(() => MoneyObject, { description: 'List price of one unit of the variant', nullable: true })
  originalPrice?: Decimal;

  @Field(() => MoneyObject, { description: 'Discount taken off one unit at checkout', nullable: true })
  discountAmount?: Decimal;

  @Field(() => Discount, { description: 'Discount applied to the order item, if any', nullable: true })
  appliedDiscount?: Discount;

  @Field(() => MoneyObject, { description: 'Unit price charged: originalPrice - discountAmount' })
  priceAtOrder: Decimal;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => Product)
  product: Product;

  @Field(() => Variant)
  variant: Variant;
}
