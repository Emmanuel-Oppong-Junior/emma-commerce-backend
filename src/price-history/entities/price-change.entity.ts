import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { PriceChangeField, PriceChangeSource } from '../../generated/prisma/client';
import { MoneyObject, MoneySource } from '../../commons/money/money.object';

registerEnumType(PriceChangeField, {
  name: 'PriceChangeField',
  description: 'Which variant price changed',
  valuesMap: {
    PRICE: { description: 'The selling price (basePrice plus tax when the product is taxable)' },
    BASE_PRICE: { description: 'The price before tax, as entered by an admin' },
  },
});

registerEnumType(PriceChangeSource, {
  name: 'PriceChangeSource',
  description: 'What changed the price',
  valuesMap: {
    ADMIN_EDIT: { description: "A staff member edited the variant's price or the product's taxability" },
    VARIANT_CREATED: { description: 'The first price of a new variant' },
    TAX_RATE_CHANGE: { description: 'A tax rate was created, changed or deleted, repricing taxable variants' },
    MIGRATION: { description: 'The price a variant had when price history started' },
  },
});

@ObjectType({ description: 'One entry of the append-only price history of a variant' })
export class PriceChange {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => PriceChangeField)
  field: PriceChangeField;

  @Field(() => MoneyObject, { nullable: true, description: 'Null for the first price of the field' })
  oldValue: MoneySource | null;

  @Field(() => MoneyObject)
  newValue: MoneySource;

  @Field(() => PriceChangeSource)
  source: PriceChangeSource;

  @Field(() => String, { nullable: true })
  reason: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member who made the change' })
  actorId: string | null;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class PriceChangePage {
  @Field(() => [PriceChange])
  nodes: PriceChange[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}
