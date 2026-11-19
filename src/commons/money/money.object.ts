import { Field, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { CurrencyEnum } from '../../products/enums/product.enum';
import { Money } from './money';

/**
 * What a `Money` field resolves to: a stored Decimal (shown in the store currency) or a Money value. MoneyResolver
 * turns it into `{ amount, currency }`.
 */
export type MoneySource = Decimal | Money;

@ObjectType('Money', { description: 'An amount of money in the store currency' })
export class MoneyObject {
  @Field(() => String, { description: 'The amount with exactly 2 decimal places, e.g. "480.00"' })
  amount: string;

  @Field(() => CurrencyEnum)
  currency: CurrencyEnum;
}
