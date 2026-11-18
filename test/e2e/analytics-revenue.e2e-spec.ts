import { INestApplication } from '@nestjs/common';
import {
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
  ReturnStatus,
} from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';

const LAPTOP = 'seed_prod1';
const PHONE = 'seed_prod2';
const NOVEL = 'analytics_novel';

interface SalesReport {
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
  totalRevenue: number;
  itemSales: number;
  orderCount: number;
  averageOrderValue: number;
}

const SALES_FIELDS = 'grossRevenue refunds netRevenue totalRevenue itemSales orderCount averageOrderValue';

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
        userId: 'seed_user',
        status: order.status,
        totalAmount: order.totalAmount,
        shippingFee: order.shippingFee ?? 0,
        couponDiscount: order.couponDiscount,
        paymentMethod: order.paymentMethod ?? PaymentMethod.ONLINE,
        contactEmail: 'user@example.com',
        contactPhone: `+23324440${String(orderCount).padStart(4, '0')}`,
        createdAt: order.createdAt,
        items: {
          create: order.items.map(([productId, quantity, price]) => ({
            productId,
            quantity,
            priceAtOrder: price,
            originalPrice: price,
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
        price: 30,
        sku: 'ANALYTICS-NOVEL',
        quantity: 100,
        images: ['novel.jpg'],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: 'analytics_books',
        brandId: 'seed_brand',
      },
    });

    // Unpaid online checkout: an open attempt, no money.
    const pendingId = await createOrder({
      status: OrderStatus.PENDING,
      items: [[LAPTOP, 1, 100]],
      shippingFee: 10,
      totalAmount: 110,
    });
    await seedPaymentAttempt(prisma, { orderId: pendingId, status: PaymentStatus.PENDING, amount: 110 });

    // Cancelled before payment.
    await createOrder({ status: OrderStatus.CANCELLED, items: [[PHONE, 1, 50]], totalAmount: 50 });

    // Paid online today, with shipping and a coupon: 230 items + 20 shipping - 10 coupon.
    const paidId = await createOrder({
      status: OrderStatus.PROCESSING,
      items: [
        [LAPTOP, 2, 100],
        [NOVEL, 1, 30],
      ],
      shippingFee: 20,
      couponDiscount: 10,
      totalAmount: 240,
    });
    await seedPaymentAttempt(prisma, { orderId: paidId, status: PaymentStatus.COMPLETED, amount: 240 });

    // Cash on delivery, collected today.
    const collectedId = await createOrder({
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [[PHONE, 1, 50]],
      shippingFee: 15,
      totalAmount: 65,
    });
    const codIntent = await prisma.paymentIntent.create({
      data: { orderId: collectedId, amount: 65, status: PaymentIntentStatus.PAID },
    });
    const codAttempt = await prisma.paymentAttempt.create({
      data: {
        intentId: codIntent.id,
        provider: PaymentProvider.CASH_ON_DELIVERY,
        channel: PaymentProvider.CASH_ON_DELIVERY,
        amount: 65,
        status: PaymentStatus.COMPLETED,
      },
    });
    await prisma.cashCollection.create({
      data: { orderId: collectedId, attemptId: codAttempt.id, amount: 65, recordedById: 'seed_admin' },
    });

    // Cash on delivery, shipped but not collected.
    await createOrder({
      status: OrderStatus.SHIPPED,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      items: [[PHONE, 3, 50]],
      totalAmount: 150,
    });

    // Paid online today, then partly refunded today through a return.
    const returnedId = await createOrder({
      status: OrderStatus.DELIVERED,
      items: [[NOVEL, 2, 30]],
      shippingFee: 10,
      totalAmount: 70,
    });
    const { paymentId: returnedAttemptId } = await seedPaymentAttempt(prisma, {
      orderId: returnedId,
      status: PaymentStatus.COMPLETED,
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
        status: PaymentStatus.COMPLETED,
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
      status: OrderStatus.DELIVERED,
      items: [[NOVEL, 1, 30]],
      totalAmount: 30,
      createdAt: oldPaidAt,
    });
    await seedPaymentAttempt(prisma, {
      orderId: oldId,
      status: PaymentStatus.COMPLETED,
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
      grossRevenue: 375,
      refunds: 40,
      netRevenue: 335,
      totalRevenue: 335,
      itemSales: 340,
      orderCount: 3,
      averageOrderValue: 125,
    });
  });

  it('recognises a payment when it was accepted, so an all-time report also counts the 2020 order', async () => {
    expect(await salesReport(new Date('2000-01-01'), inAMinute())).toEqual({
      grossRevenue: 405,
      refunds: 40,
      netRevenue: 365,
      totalRevenue: 365,
      itemSales: 370,
      orderCount: 4,
      averageOrderValue: 101.25,
    });
    expect(await salesReport(new Date('2020-06-01'), new Date('2020-06-02'))).toMatchObject({
      grossRevenue: 30,
      refunds: 0,
      orderCount: 1,
    });
  });

  it("shows the same figures on the dashboard as today's sales report", async () => {
    const { dashboardSummary } = await gql<{ dashboardSummary: Record<string, number> }>(
      '{ dashboardSummary { ordersToday revenueToday grossRevenueToday refundsToday } }',
    );
    const today = await salesReport(startOfToday(), inAMinute());

    expect(dashboardSummary).toEqual({
      ordersToday: today.orderCount,
      revenueToday: today.netRevenue,
      grossRevenueToday: today.grossRevenue,
      refundsToday: today.refunds,
    });
    expect(dashboardSummary).toEqual({ ordersToday: 3, revenueToday: 335, grossRevenueToday: 375, refundsToday: 40 });
  });

  it('breaks down item sales of paid orders only, adding up to the all-time item sales', async () => {
    const { topProducts, revenueByCategory } = await gql<{
      topProducts: { productId: string; totalQuantitySold: number; totalRevenue: number }[];
      revenueByCategory: { categoryName: string; totalRevenue: number; orderCount: number }[];
    }>(
      `{
        topProducts(limit: 10) { productId totalQuantitySold totalRevenue }
        revenueByCategory { categoryName totalRevenue orderCount }
      }`,
    );
    const allTime = await salesReport(new Date('2000-01-01'), inAMinute());

    expect(topProducts).toEqual([
      { productId: NOVEL, totalQuantitySold: 4, totalRevenue: 120 },
      { productId: LAPTOP, totalQuantitySold: 2, totalRevenue: 200 },
      { productId: PHONE, totalQuantitySold: 1, totalRevenue: 50 },
    ]);
    expect(revenueByCategory).toEqual([
      { categoryName: 'Electronics', totalRevenue: 250, orderCount: 2 },
      { categoryName: 'Books', totalRevenue: 120, orderCount: 3 },
    ]);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(sum(topProducts.map((p) => p.totalRevenue))).toBe(allTime.itemSales);
    expect(sum(revenueByCategory.map((c) => c.totalRevenue))).toBe(allTime.itemSales);
    // Paid orders' shipping (20 + 15 + 10) minus their coupon discount (10).
    expect(allTime.grossRevenue - allTime.itemSales).toBe(35);
  });
});
