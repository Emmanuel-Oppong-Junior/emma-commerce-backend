import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { DiscountType } from '../enums/discount-type.enum';
import { Product } from '../../products/entities/product.entity';
import { Variant } from '../../variant/entities/variant.entity';
import { Category } from '../../categories/entities/category.entity';
import { MoneyObject } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

/**
 * GraphQL entity representing a discount in the e-commerce system.
 */
@ObjectType()
export class Discount {
  @Field(() => ID, { description: 'Unique identifier for the discount' })
  id: string;

  @Field(() => String, { description: 'Name of the discount (e.g., "Summer Sale 2025")' })
  name: string;

  @Field(() => String, { description: 'Detailed description of the discount', nullable: true })
  description?: string;

  @Field(() => DiscountType, { description: 'Type of discount (e.g., PERCENTAGE or FIXED_AMOUNT)' })
  type: DiscountType;

  @Field(() => GraphQLDecimal, { description: 'Discount value (e.g., 20 for 20% or 10.00 for $10 off)' })
  value: Decimal;

  @Field(() => GraphQLISODateTime, { description: 'Start date and time of the discount' })
  startDate: Date;

  @Field(() => GraphQLISODateTime, { description: 'End date and time of the discount' })
  endDate: Date;

  @Field(() => Boolean, { description: 'Whether the discount is currently active' })
  isActive: boolean;

  @Field(() => [Product], { description: 'Products to which the discount applies', nullable: true })
  products: Product[];

  @Field(() => [Variant], { description: 'Variants to which the discount applies', nullable: true })
  variants: Variant[];

  @Field(() => [Category], { description: 'Categories to which the discount applies', nullable: true })
  categories: Category[];

  @Field(() => MoneyObject, { description: 'Minimum purchase amount to qualify for the discount', nullable: true })
  minimumPurchase?: Decimal;

  @Field(() => GraphQLISODateTime, { description: 'Timestamp when the discount was created' })
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { description: 'Timestamp when the discount was last updated' })
  updatedAt: Date;
}
