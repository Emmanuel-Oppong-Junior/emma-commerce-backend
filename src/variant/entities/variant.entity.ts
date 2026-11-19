import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Product } from '../../products/entities/product.entity';
import { MoneyObject } from '../../commons/money/money.object';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class Variant {
  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  size?: string;

  @Field({ nullable: true })
  color?: string;

  @Field()
  quantity: number;

  @Field(() => MoneyObject)
  price: Decimal;

  @Field(() => ID)
  productId: string;

  @Field(() => Product)
  product: Product;

  @Field(() => ID, { nullable: true })
  discountId?: string;
}
