import { Decimal } from '@prisma/client/runtime/client';
import { averageOrderValue, DailySales, salesTotals } from './sales-totals';

const d = (value: string) => new Decimal(value);

function dayOf(values: Partial<DailySales>): DailySales {
  const zero = d('0');
  return {
    day: new Date('2026-01-01T00:00:00Z'),
    paidOrders: 0,
    unitsSold: 0,
    grossRevenue: zero,
    itemSales: zero,
    itemDiscounts: zero,
    orderDiscounts: zero,
    loyaltyDiscounts: zero,
    shipping: zero,
    shippingDiscounts: zero,
    tax: zero,
    refundCount: 0,
    refunds: zero,
    refundedShipping: zero,
    refundedTax: zero,
    unallocatedRefunds: zero,
    ordersPlaced: 0,
    cartsStarted: 0,
    checkoutQuotes: 0,
    ...values,
  };
}

describe('salesTotals (P8-A)', () => {
  it('adds days up and deducts refunds by the day they were processed', () => {
    const totals = salesTotals([
      dayOf({ paidOrders: 2, unitsSold: 3, grossRevenue: d('240.00'), refunds: d('0'), shipping: d('20.00') }),
      dayOf({ paidOrders: 1, unitsSold: 1, grossRevenue: d('65.00'), refunds: d('40.00'), refundCount: 1 }),
    ]);

    expect(totals).toMatchObject({
      paidOrders: 3,
      unitsSold: 4,
      refundCount: 1,
      grossRevenue: d('305'),
      refunds: d('40'),
      shipping: d('20'),
      netRevenue: d('265'),
      averageOrderValue: d('88.33'),
    });
  });

  it('reports a negative net when a refund lands on a day without sales, and no average without orders', () => {
    const totals = salesTotals([dayOf({ refunds: d('70.00'), refundCount: 1 })]);

    expect(totals.netRevenue).toEqual(d('-70'));
    expect(totals.averageOrderValue).toEqual(d('0'));
  });

  it('rounds the average order value half-up to the pesewa', () => {
    expect(averageOrderValue(d('100.00'), 8)).toEqual(d('12.5'));
    expect(averageOrderValue(d('0.05'), 2)).toEqual(d('0.03'));
    expect(averageOrderValue(d('-0.05'), 2)).toEqual(d('-0.03'));
  });

  it('gives zeros for no days', () => {
    expect(salesTotals([])).toMatchObject({ paidOrders: 0, netRevenue: d('0'), averageOrderValue: d('0') });
  });
});
