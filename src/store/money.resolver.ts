import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Currency } from '../generated/prisma/client';
import { CurrencyEnum } from '../products/enums/product.enum';
import { Money, roundHalfUp } from '../commons/money/money';
import { MoneyObject, MoneySource } from '../commons/money/money.object';
import { StoreService } from './store.service';

@Resolver(() => MoneyObject)
export class MoneyResolver {
  // Read once per GraphQL request, however many Money fields the response holds; the context object is per request.
  private readonly currencyByRequest = new WeakMap<object, Promise<Currency>>();

  constructor(private readonly storeService: StoreService) {}

  @ResolveField(() => String)
  amount(@Parent() value: MoneySource): string {
    return value instanceof Money ? value.toString() : roundHalfUp(value).toFixed(2);
  }

  @ResolveField(() => CurrencyEnum)
  currency(@Parent() value: MoneySource, @Context() context: object): Currency | Promise<Currency> {
    if (value instanceof Money) return value.currency;
    let currency = this.currencyByRequest.get(context);
    if (!currency) {
      currency = this.storeService.getCurrency();
      this.currencyByRequest.set(context, currency);
    }
    return currency;
  }
}
