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
  totalRevenue: MoneyValue;
  itemSales: MoneyValue;
  orderCount: number;
  averageOrderValue: MoneyValue;
}

const M = '{ amount currency }';
const SALES_FIELDS = `grossRevenue ${M} refunds ${M} netRevenue ${M} totalRevenue ${M} itemSales ${M} orderCount averageOrderValue ${M}`;

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
  const salesReport = async (start: Date, end: Date) =>
    (
      await gql<{ salesReport: SalesReport }>(
        `{ salesReport(startDate: "${start.toISOString()}", endDate: "${end.toISOString()}") { ${SALES_FIELDS} } }`,
      )
    ).salesReport;

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
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  const startOfToday = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
  };
  const inAMinute = () => new Date(Date.now() + 60_000);

  it("reports today's revenue from accepted payments minus processed refunds, ignoring unpaid and review payments", async () => {
    expect(await salesReport(startOfToday(), inAMinute())).toEqual({
      grossRevenue: ghs('375.00'),
      refunds: ghs('40.00'),
      netRevenue: ghs('335.00'),
      totalRevenue: ghs('335.00'),
      itemSales: ghs('340.00'),
      orderCount: 3,
      averageOrderValue: ghs('125.00'),
    });
  });

  it('recognises a payment when it was accepted, so an all-time report also counts the 2020 order', async () => {
    expect(await salesReport(new Date('2000-01-01'), inAMinute())).toEqual({
      grossRevenue: ghs('405.00'),
      refunds: ghs('40.00'),
      netRevenue: ghs('365.00'),
      totalRevenue: ghs('365.00'),
      itemSales: ghs('370.00'),
      orderCount: 4,
      averageOrderValue: ghs('101.25'),
    });
    expect(await salesReport(new Date('2020-06-01'), new Date('2020-06-02'))).toMatchObject({
      grossRevenue: ghs('30.00'),
      refunds: ghs('0.00'),
      orderCount: 1,
    });
  });

  it("shows the same figures on the dashboard as today's sales report", async () => {
    const { dashboardSummary } = await gql<{ dashboardSummary: Record<string, unknown> }>(
      `{ dashboardSummary { ordersToday revenueToday ${M} grossRevenueToday ${M} refundsToday ${M} } }`,
    );
    const today = await salesReport(startOfToday(), inAMinute());

    expect(dashboardSummary).toEqual({
      ordersToday: today.orderCount,
      revenueToday: today.netRevenue,
      grossRevenueToday: today.grossRevenue,
      refundsToday: today.refunds,
    });
    expect(dashboardSummary).toEqual({
      ordersToday: 3,
      revenueToday: ghs('335.00'),
      grossRevenueToday: ghs('375.00'),
      refundsToday: ghs('40.00'),
    });
  });

  it('breaks down item sales of paid orders only, adding up to the all-time item sales', async () => {
    const { topProducts, revenueByCategory } = await gql<{
      topProducts: { productId: string; totalQuantitySold: number; totalRevenue: MoneyValue }[];
      revenueByCategory: { categoryName: string; totalRevenue: MoneyValue; orderCount: number }[];
    }>(
      `{
        topProducts(limit: 10) { productId totalQuantitySold totalRevenue ${M} }
        revenueByCategory { categoryName totalRevenue ${M} orderCount }
      }`,
    );
    const allTime = await salesReport(new Date('2000-01-01'), inAMinute());

    expect(topProducts).toEqual([
      { productId: NOVEL, totalQuantitySold: 4, totalRevenue: ghs('120.00') },
      { productId: LAPTOP, totalQuantitySold: 2, totalRevenue: ghs('200.00') },
      { productId: PHONE, totalQuantitySold: 1, totalRevenue: ghs('50.00') },
    ]);
    expect(revenueByCategory).toEqual([
      { categoryName: 'Electronics', totalRevenue: ghs('250.00'), orderCount: 2 },
      { categoryName: 'Books', totalRevenue: ghs('120.00'), orderCount: 3 },
    ]);
    const sum = (values: MoneyValue[]) =>
      values.reduce((total, value) => total.add(value.amount), new Prisma.Decimal(0)).toFixed(2);
    expect(sum(topProducts.map((p) => p.totalRevenue))).toBe(allTime.itemSales.amount);
    expect(sum(revenueByCategory.map((c) => c.totalRevenue))).toBe(allTime.itemSales.amount);
    // Paid orders' shipping (20 + 15 + 10) minus their coupon discount (10).
    expect(new Prisma.Decimal(allTime.grossRevenue.amount).sub(allTime.itemSales.amount).toFixed(2)).toBe('35.00');
  });
});
