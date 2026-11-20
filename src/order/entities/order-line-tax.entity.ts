import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';

@ObjectType({ description: 'A tax included in an order line, as computed when the order was placed' })
export class OrderLineTax {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { nullable: true, description: 'The tax rate it came from (it may have changed since)' })
  taxId?: string | null;

  @Field()
  name: string;

  @Field(() => GraphQLDecimal, { description: 'Rate as a decimal when ordered (e.g., 0.15 for 15%)' })
  rate: Decimal;

  @Field(() => MoneyObject, { description: 'The line amount without tax that the rate applied to' })
  base: Decimal;

  @Field(() => MoneyObject)
  amount: Decimal;
}
