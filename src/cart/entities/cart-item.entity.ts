import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { Variant } from '../../variant/entities/variant.entity';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class CartItem {
  @Field(() => ID, { description: 'Unique identifier of the cart item' })
  id: string;

  @Field(() => String, { description: 'ID of the product of the variant' })
  productId: string;

  @Field(() => Product, { description: 'The product in the cart' })
  product: Product;

  @Field(() => ID, { description: 'ID of the variant (SKU) in the cart' })
  variantId: string;

  @Field(() => Variant, { description: 'The variant (SKU) in the cart: what is priced and stocked' })
  variant: Variant;

  @Field(() => MoneyObject, { description: 'List price of one unit of the variant', nullable: true })
  originalPrice?: Decimal;

  @Field(() => Int, { description: 'Quantity of the product in the cart' })
  quantity: number;

  @Field(() => Date, { description: 'Timestamp when the item was added' })
  createdAt: Date;

  @Field(() => Date, {
    description: 'Timestamp when the item was last updated',
  })
  updatedAt: Date;
}
