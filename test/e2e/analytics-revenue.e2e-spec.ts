import { INestApplication } from '@nestjs/common';
import {
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentReviewReason,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ReturnStatus,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AnalyticsRollupService } from '../../src/analytics/rollup/analytics-rollup.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest, MoneyValue } from '../helpers/graphql.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber, setStock } from '../helpers/db.helper';

const LAPTOP = 'seed_prod1';
const PHONE = 'seed_prod2';
const NOVEL = 'analytics_novel';
const VARIANT_OF: Record<string, string> = {
  [LAPTOP]: 'seed_var1',
  [PHONE]: 'seed_var2',
  [NOVEL]: 'analytics_novel_var',
};

interface SalesReport {
  grossRevenue: MoneyValue;
  refunds: MoneyValue;
  netRevenue: MoneyValue;
  itemSales: MoneyValue;
  paidOrders: number;
  averageOrderValue: MoneyValue;
}

const M = '{ amount currency }';
const SALES_FIELDS = `grossRevenue ${M} refunds ${M} netRevenue ${M} itemSales ${M} paidOrders averageOrderValue ${M}`;
const OLD_DAY = '2020-06-01';
const dayKey = (at: Date) => at.toISOString().slice(0, 10);
const add = (...values: MoneyValue[]) =>
  ghs(values.reduce((total, value) => total.add(value.amount), new Prisma.Decimal(0)).toFixed(2));

describe('Analytics revenue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let orderCount = 0;

  const gql = async <T>(query: string): Promise<T> => {
    const body = (await gqlRequest(app, query, undefined, adminToken).expect(200)).body;
    expect(body.errors).toBeUndefined();
    return body.data as T;
  };
  // P8-A: reports read the daily rollups, rebuilt below after seeding; ranges are inclusive UTC days.
  const salesReport = async (firstDay: string, lastDay: string) =>
    (
      await gql<{ salesReport: { totals: SalesReport } }>(
        `{ salesReport(firstDay: "${firstDay}", lastDay: "${lastDay}") { totals { ${SALES_FIELDS} } } }`,
      )
    ).salesReport.totals;

  const createOrder = async (order: {
    status: OrderStatus;
    items: [productId: string, quantity: number, price: number][];
    totalAmount: number;
    shippingFee?: number;
    couponDiscount?: number;
    paymentMethod?: PaymentMethod;
    createdAt?: Date;
  }): Promise<string> => {
    orderCount += 1;
    const created = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        status: order.status,
        currency: 'GHS',
        pricingVersion: 0,
        grandTotal: order.totalAmount,
        shippingTotal: order.shippingFee ?? 0,
        adjustments: { create: order.couponDiscount ? [{ type: 'COUPON', amount: -order.couponDiscount }] : [] },
        paymentMethod: order.paymentMethod ?? PaymentMethod.ONLINE,
        contactEmail: 'user@example.com',
        contactPhone: `+23324440${String(orderCount).padStart(4, '0')}`,
        createdAt: order.createdAt,
        items: {
          create: order.items.map(([productId, quantity, price]) => ({
            productId,
            variantId: VARIANT_OF[productId],
            quantity,
            productName: productId,
            unitListPrice: price,
            unitDiscount: 0,
            lineTotal: price * quantity,
          })),
        },
      },
    });
    return created.id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);

    await prisma.category.create({ data: { id: 'analytics_books', name: 'Books' } });
    await prisma.product.create({
      data: {
        id: NOVEL,
        name: 'Novel',
        variants: {
          create: { id: VARIANT_OF[NOVEL], sku: 'ANALYTICS-NOVEL', price: 30, basePrice: 30 },
        },
        images: ['novel.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: 'analytics_books',
        brandId: 'seed_brand',
      },
    });
    await setStock(prisma, VARIANT_OF[NOVEL], 100);

    // Unpaid online checkout: an open attempt, no money.
    const pendingId = await createOrder({
      status: OrderStatus.PLACED,
      items: [[LAPTOP, 1, 100]],
      shippingFee: 10,
      totalAmount: 110,
    });
    await seedPaymentAttempt(prisma, { orderId: pendingId, status: PaymentStatus.PENDING, amount: 110 });

    // Cancelled before payment.
    await createOrder({ status: OrderStatus.CANCELLED, items: [[PHONE, 1, 50]], totalAmount: 50 });

    // Paid online today, with shipping and a coupon: 230 items + 20 shipping - 10 coupon.
    const paidId = await createOrder({
      status: OrderStatus.CONFIRMED,
      items: [
        [LAPTOP, 2, 100],
        [NOVEL, 1, 30],
      ],
      shippingFee: 20,
      couponDiscount: 10,
      totalAmount: 240,
    });
    await seedPaymentAttempt(prisma, { orderId: paidId, status: PaymentStatus.CAPTURED, amount: 240 });

    // Cash on delivery, collected today.
    const collectedId = await createOrder({
      status: OrderStatus.COMPLETED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [[PHONE, 1, 50]],
      shippingFee: 15,
      totalAmount: 65,
    });
    const codIntent = await prisma.paymentIntent.create({
      data: { orderId: collectedId, amount: 65, status: PaymentIntentStatus.CAPTURED },
    });
    const codAttempt = await prisma.paymentAttempt.create({
      data: {
        intentId: codIntent.id,
        provider: PaymentProvider.CASH_ON_DELIVERY,
        channel: PaymentProvider.CASH_ON_DELIVERY,
        amount: 65,
        status: PaymentStatus.CAPTURED,
      },
    });
    await prisma.cashCollection.create({
      data: { orderId: collectedId, attemptId: codAttempt.id, amount: 65, recordedById: 'seed_admin' },
    });

    // Cash on delivery, shipped but not collected.
    await createOrder({
      status: OrderStatus.IN_FULFILMENT,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [[PHONE, 3, 50]],
      totalAmount: 150,
    });

    // Paid online today, then partly refunded today through a return.
    const returnedId = await createOrder({
      status: OrderStatus.COMPLETED,
      items: [[NOVEL, 2, 30]],
      shippingFee: 10,
      totalAmount: 70,
    });
    const { paymentId: returnedAttemptId } = await seedPaymentAttempt(prisma, {
      orderId: returnedId,
      status: PaymentStatus.CAPTURED,
      amount: 70,
    });
    const returnRequest = await prisma.returnRequest.create({
      data: {
        orderId: returnedId,
        userId: 'seed_user',
        reason: 'One copy was damaged',
        status: ReturnStatus.REFUNDED,
        refundAmount: 40,
      },
    });
    await prisma.refund.create({
      data: {
        attemptId: returnedAttemptId,
        returnRequestId: returnRequest.id,
        amount: 40,
        status: RefundStatus.PROCESSED,
        providerRef: 'rf_analytics_return',
        idempotencyKey: `return:${returnRequest.id}`,
        reason: 'RETURN',
      },
    });

    // Late payment on a cancelled order: captured, held for review and refunded automatically. Never revenue.
    const lateId = await createOrder({ status: OrderStatus.CANCELLED, items: [[LAPTOP, 1, 100]], totalAmount: 100 });
    const lateIntent = await prisma.paymentIntent.create({ data: { orderId: lateId, amount: 100 } });
    const lateAttempt = await prisma.paymentAttempt.create({
      data: {
        intentId: lateIntent.id,
        provider: PaymentProvider.PAYSTACK,
        reference: 'ref-analytics-late',
        channel: 'card',
        amount: 100,
        status: PaymentStatus.CAPTURED,
        reviewReason: PaymentReviewReason.ORDER_NOT_PAYABLE,
      },
    });
    await prisma.refund.create({
      data: {
        attemptId: lateAttempt.id,
        amount: 100,
        status: RefundStatus.PROCESSED,
        providerRef: 'rf_analytics_auto',
        idempotencyKey: `auto-refund:${lateAttempt.id}`,
        reason: 'PAYMENT_NOT_ACCEPTED',
      },
    });

    // Paid online in 2020: outside today's window, inside all time.
    const oldPaidAt = new Date('2020-06-01T12:00:00Z');
    const oldId = await createOrder({
      status: OrderStatus.COMPLETED,
      items: [[NOVEL, 1, 30]],
      totalAmount: 30,
      createdAt: oldPaidAt,
    });
    await seedPaymentAttempt(prisma, {
      orderId: oldId,
      status: PaymentStatus.CAPTURED,
      amount: 30,
      updatedAt: oldPaidAt,
    });

    const rollups = app.get(AnalyticsRollupService);
    await rollups.rebuildRecent();
    await rollups.rebuild({ from: new Date(`${OLD_DAY}T00:00:00Z`), to: new Date('2020-06-02T00:00:00Z') });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  const today = () => dayKey(new Date());

  it("reports today's revenue from accepted payments minus processed refunds, ignoring unpaid and review payments", async () => {
    // P8-A decision: the average order value is net revenue / paid orders (it was gross / orders, 125.00).
    expect(await salesReport(today(), today())).toEqual({
      grossRevenue: ghs('375.00'),
      refunds: ghs('40.00'),
      netRevenue: ghs('335.00'),
      itemSales: ghs('340.00'),
      paidOrders: 3,
      averageOrderValue: ghs('111.67'),
    });
  });

  it('recognises a payment when it was accepted, so the 2020 order counts on its 2020 day', async () => {
    // A report spans at most 731 days, so all time is the 2020 day plus today (nothing else was paid).
    const old = await salesReport(OLD_DAY, OLD_DAY);
    const recent = await salesReport(today(), today());

    expect(old).toEqual({
      grossRevenue: ghs('30.00'),
      refunds: ghs('0.00'),
      netRevenue: ghs('30.00'),
      itemSales: ghs('30.00'),
      paidOrders: 1,
      averageOrderValue: ghs('30.00'),
    });
    expect({
      grossRevenue: add(old.grossRevenue, recent.grossRevenue),
      refunds: add(old.refunds, recent.refunds),
      netRevenue: add(old.netRevenue, recent.netRevenue),
      itemSales: add(old.itemSales, recent.itemSales),
      paidOrders: old.paidOrders + recent.paidOrders,
    }).toEqual({
      grossRevenue: ghs('405.00'),
      refunds: ghs('40.00'),
      netRevenue: ghs('365.00'),
      itemSales: ghs('370.00'),
      paidOrders: 4,
    });
  });

  it("shows the same figures on the dashboard as today's sales report", async () => {
    const { dashboardSummary } = await gql<{ dashboardSummary: Record<string, unknown> }>(
      `{ dashboardSummary { ordersToday revenueToday ${M} grossRevenueToday ${M} refundsToday ${M} } }`,
    );
    const todays = await salesReport(today(), today());

    expect(dashboardSummary).toEqual({
      ordersToday: todays.paidOrders,
      revenueToday: todays.netRevenue,
      grossRevenueToday: todays.grossRevenue,
      refundsToday: todays.refunds,
    });
    expect(dashboardSummary).toEqual({
      ordersToday: 3,
      revenueToday: ghs('335.00'),
      grossRevenueToday: ghs('375.00'),
      refundsToday: ghs('40.00'),
    });
  });

  it('breaks down item sales of paid orders only, adding up to the item sales of the same days', async () => {
    const breakdowns = async (firstDay: string, lastDay: string) =>
      gql<{
        topProducts: { productId: string; unitsSold: number; sales: MoneyValue }[];
        topCategories: { categoryName: string; sales: MoneyValue }[];
      }>(
        `{
          topProducts(firstDay: "${firstDay}", lastDay: "${lastDay}", first: 10) { productId unitsSold sales ${M} }
          topCategories(firstDay: "${firstDay}", lastDay: "${lastDay}") { categoryName sales ${M} }
        }`,
      );
    const recent = await breakdowns(today(), today());
    const old = await breakdowns(OLD_DAY, OLD_DAY);
    const recentSales = await salesReport(today(), today());
    const oldSales = await salesReport(OLD_DAY, OLD_DAY);

    expect(recent.topProducts).toEqual([
      { productId: NOVEL, unitsSold: 3, sales: ghs('90.00') },
      { productId: LAPTOP, unitsSold: 2, sales: ghs('200.00') },
      { productId: PHONE, unitsSold: 1, sales: ghs('50.00') },
    ]);
    expect(old.topProducts).toEqual([{ productId: NOVEL, unitsSold: 1, sales: ghs('30.00') }]);
    expect(recent.topCategories).toEqual([
      { categoryName: 'Electronics', sales: ghs('250.00') },
      { categoryName: 'Books', sales: ghs('90.00') },
    ]);
    expect(old.topCategories).toEqual([{ categoryName: 'Books', sales: ghs('30.00') }]);
    // All time, as before P8-A: the novel sold 4 units for 120.00, books 120.00 in all.
    expect(add(recent.topProducts[0].sales, old.topProducts[0].sales)).toEqual(ghs('120.00'));
    expect(add(...recent.topProducts.map((p) => p.sales))).toEqual(recentSales.itemSales);
    expect(add(...recent.topCategories.map((c) => c.sales))).toEqual(recentSales.itemSales);
    expect(add(...old.topCategories.map((c) => c.sales))).toEqual(oldSales.itemSales);
    // Paid orders' shipping (20 + 15 + 10) minus their coupon discount (10).
    expect(new Prisma.Decimal(recentSales.grossRevenue.amount).sub(recentSales.itemSales.amount).toFixed(2)).toBe(
      '35.00',
    );
  });
});
