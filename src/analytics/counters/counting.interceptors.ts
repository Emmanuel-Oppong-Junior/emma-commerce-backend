import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { mergeMap, Observable } from 'rxjs';
import { AnalyticsCounter, AnalyticsCounters } from './analytics-counters';

interface CartResult {
  items: { quantity: number }[];
}

/**
 * An add-to-cart that leaves the cart with a single line holding exactly the units just added found the cart empty:
 * a cart was started. Read from the result so the cart service stays unaware of analytics.
 */
export function startedCart(added: number, cart: CartResult | null | undefined): boolean {
  return cart?.items.length === 1 && cart.items[0].quantity === added;
}

/** On addToCart / addToGuestCart: counts the carts started (P8-A funnel). GraphQL only; anything else passes through. */
@Injectable()
export class CountCartStarts implements NestInterceptor {
  constructor(private readonly counters: AnalyticsCounters) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<GqlContextType>() !== 'graphql') return next.handle();
    const added = GqlExecutionContext.create(context).getArgs<{ input?: { quantity?: number } }>().input?.quantity;
    return next.handle().pipe(
      mergeMap(async (cart: CartResult | null) => {
        if (added !== undefined && startedCart(added, cart))
          await this.counters.increment(AnalyticsCounter.CartsStarted);
        return cart;
      }),
    );
  }
}

/** On checkoutQuote / guestCheckoutQuote: counts each quote given (P8-A funnel); refusals are not counted. */
@Injectable()
export class CountCheckoutQuotes implements NestInterceptor {
  constructor(private readonly counters: AnalyticsCounters) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      mergeMap(async (quote: unknown) => {
        await this.counters.increment(AnalyticsCounter.CheckoutQuotes);
        return quote;
      }),
    );
  }
}
