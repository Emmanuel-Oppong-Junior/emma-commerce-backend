import { lastValueFrom, of } from 'rxjs';
import { CountCheckoutQuotes, startedCart } from './counting.interceptors';
import { AnalyticsCounter } from './analytics-counters';

describe('counting interceptors (P8-A funnel)', () => {
  it('counts a cart as started when the add left one line holding exactly the units added', () => {
    expect(startedCart(2, { items: [{ quantity: 2 }] })).toBe(true);
    expect(startedCart(1, { items: [{ quantity: 3 }] })).toBe(false);
    expect(startedCart(1, { items: [{ quantity: 1 }, { quantity: 1 }] })).toBe(false);
    expect(startedCart(1, null)).toBe(false);
  });

  it('counts a checkout quote once it was given, and returns it unchanged', async () => {
    const counters = { increment: jest.fn() };
    const interceptor = new CountCheckoutQuotes(counters as never);
    const quote = { quoteHash: 'abc' };

    const result = await lastValueFrom(interceptor.intercept({} as never, { handle: () => of(quote) }));

    expect(result).toBe(quote);
    expect(counters.increment).toHaveBeenCalledWith(AnalyticsCounter.CheckoutQuotes);
  });
});
