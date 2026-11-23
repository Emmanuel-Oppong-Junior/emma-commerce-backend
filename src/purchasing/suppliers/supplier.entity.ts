import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Currency } from '../../generated/prisma/client';
import { CurrencyEnum } from '../../products/enums/product.enum';

@ObjectType({ description: 'Someone the store buys from (staff with purchasing.view)' })
export class Supplier {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Unique ignoring case' })
  name: string;

  @Field(() => String, { nullable: true })
  contactName: string | null;

  @Field(() => String, { nullable: true })
  phone: string | null;

  @Field(() => String, { nullable: true })
  email: string | null;

  @Field(() => String, { nullable: true })
  address: string | null;

  @Field(() => String, { nullable: true })
  notes: string | null;

  @Field(() => CurrencyEnum, { description: 'The currency the supplier is paid in; the store currency for now' })
  currency: Currency;

  @Field({ description: 'Inactive suppliers take no new purchase orders; their history stays' })
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class SupplierPage {
  @Field(() => [Supplier])
  nodes: Supplier[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}
