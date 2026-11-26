import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { CollectionType } from '../../../generated/prisma/client';
import { GraphQLDecimal } from '../../../commons/money/decimal.scalar';
import { SeoFields } from '../../../seo/entities/seo-fields.entity';

registerEnumType(CollectionType, {
  name: 'CollectionType',
  description: 'MANUAL: staff pick the products and their order; RULE: the products matching its rules',
});

@ObjectType({ description: 'The rules of a rule-based collection; unset rules are null' })
export class CollectionRules {
  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field(() => ID, { nullable: true })
  subcategoryId?: string;

  @Field(() => ID, { nullable: true })
  brandId?: string;

  @Field(() => ID, { nullable: true })
  tagId?: string;

  @Field(() => ID, { nullable: true })
  productTypeId?: string;

  @Field(() => GraphQLDecimal, { nullable: true })
  priceMin?: Decimal;

  @Field(() => GraphQLDecimal, { nullable: true })
  priceMax?: Decimal;

  @Field(() => Boolean, { nullable: true })
  onSale?: boolean;

  @Field(() => Boolean, { nullable: true })
  inStock?: boolean;
}

@ObjectType({ description: 'A merchandised product list with its own page' })
export class Collection extends SeoFields {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => String, { nullable: true })
  imageUrl: string | null;

  @Field(() => CollectionType)
  type: CollectionType;

  @Field(() => Boolean)
  isActive: boolean;

  @Field(() => Date, { nullable: true })
  startsAt: Date | null;

  @Field(() => Date, { nullable: true, description: 'Exclusive' })
  endsAt: Date | null;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;
}
