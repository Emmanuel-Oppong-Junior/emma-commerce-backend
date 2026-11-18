import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { Discount } from '../../discount/entities/discount.entity';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class OrderItem {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ID)
  productId: string;

  @Field(() => ID, { nullable: true })
  variantId?: string;

  @Field()
  quantity: number;

  @Field(() => Float, { description: 'Original price per unit of the product or variant', nullable: true })
  originalPrice?: Decimal;

  @Field(() => Float, { description: 'Discount taken off one unit at checkout', nullable: true })
  discountAmount?: Decimal;

  @Field(() => Discount, { description: 'Discount applied to the order item, if any', nullable: true })
  appliedDiscount?: Discount;

  @Field(() => Float, { description: 'Unit price charged: originalPrice - discountAmount' })
  priceAtOrder: Decimal;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => Product)
  product: Product;
}
