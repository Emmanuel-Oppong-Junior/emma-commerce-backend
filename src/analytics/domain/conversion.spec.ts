import { funnel } from './conversion';

describe('funnel (P8-A)', () => {
  it('adds the steps up and gives each ratio to 4 dp', () => {
    expect(
      funnel([
        { cartsStarted: 2, checkoutQuotes: 5, ordersPlaced: 2, paidOrders: 1 },
        { cartsStarted: 1, checkoutQuotes: 1, ordersPlaced: 1, paidOrders: 1 },
      ]),
    ).toEqual({
      cartsStarted: 3,
      checkoutQuotes: 6,
      ordersPlaced: 3,
      paidOrders: 2,
      quoteRate: 2,
      placementRate: 0.5,
      paymentRate: 0.6667,
      conversionRate: 0.6667,
    });
  });

  it('has no ratio when the step before counted nothing', () => {
    expect(funnel([{ cartsStarted: 0, checkoutQuotes: 0, ordersPlaced: 1, paidOrders: 1 }])).toMatchObject({
      quoteRate: null,
      placementRate: null,
      paymentRate: 1,
      conversionRate: null,
    });
  });
});
