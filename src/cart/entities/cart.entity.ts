import { Field, ID, ObjectType } from '@nestjs/graphql';
import { CartItem } from './cart-item.entity';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class Cart {
  @Field(() => ID, { description: 'Unique identifier of the cart' })
  id: string;

  @Field(() => String, { description: 'ID of the user owning the cart' })
  userId: string;

  @Field(() => [CartItem], { description: 'Items in the cart' })
  items: CartItem[];

  @Field(() => MoneyObject, { description: 'Total original price of all items', nullable: true })
  total: Decimal;

  @Field(() => MoneyObject, { description: 'Total discount amount applied', nullable: true })
  discountTotal: Decimal;

  @Field(() => MoneyObject, {
    description: 'Final total after discounts; createOrder charges this for the items',
    nullable: true,
  })
  finalTotal?: Decimal;

  @Field(() => Date, { description: 'Timestamp when the cart was created' })
  createdAt: Date;

  @Field(() => Date, {
    description: 'Timestamp when the cart was last updated',
  })
  updatedAt: Date;
}
