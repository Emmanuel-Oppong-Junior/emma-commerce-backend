import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { AnalyticsRollupService } from '../../src/analytics/rollup/analytics-rollup.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInSuperAdmin, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber } from '../helpers/db.helper';
import { createCoupon, createPromotion } from '../helpers/promotion.helper';

const M = '{ amount }';
const D1 = '2026-01-05'; // a Monday
const D2 = '2026-01-06';
const D3 = '2026-01-07';
const FEB = '2026-02-10';
const at = (day: string, time = '10:00:00') => new Date(`${day}T${time}Z`);
const day = (text: string) => new Date(`${text}T00:00:00Z`);
const amount = (value: string) => ({ amount: value });

interface LineSpec {
  variantId: string;
  productId: string;
  quantity: number;
  unitListPrice: string;
  unitDiscount?: string;
  unitNet: string;
  unitTax: string;
  lineTotal: string;
  share?: string;
  unitCost: string | null;
}

// P8-A reports on a hand-built scenario: paid online and cash-on-delivery orders, an unpaid and a cancelled order, a
// guest order, a coupon, a flash sale, loyalty points, a partial and a full refund, a restock and a cost unknown.
describe('Analytics reports (P8-A, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rollups: AnalyticsRollupService;
  let ownerToken: string;
  let reporterToken: string;
  let locationId: string;
  let couponPromotionId: string;
  let flashPromotionId: string;
  const orderIds: Record<string, string> = {};
  const lineIds: Record<string, string> = {};

  const gql = async <T>(query: string, token = ownerToken): Promise<T> => {
    const body = (await gqlRequest(app, query, undefined, token).expect(200)).body;
    expect(body.errors).toBeUndefined();
    return body.data as T;
  };
  const gqlErrors = async (query: string, token = ownerToken) =>
    ((await gqlRequest(app, query, undefined, token).expect(200)).body.errors ?? []) as {
      message: string;
      extensions: { code: string };
    }[];

  const createOrder = async (
    key: string,
    order: {
      userId?: string;
      guestPhone?: string;
      createdAt: Date;
      grandTotal: string;
      shippingTotal?: string;
      taxTotal?: string;
      paymentMethod?: PaymentMethod;
      status?: 'PLACED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
      line: LineSpec;
      adjustments?: Prisma.OrderAdjustmentCreateManyOrderInput[];
    },
  ) => {
    const { line } = order;
    const created = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: order.userId ?? null,
        guestPhone: order.guestPhone,
        guestPhoneVerifiedAt: order.guestPhone ? order.createdAt : undefined,
        contactName: order.guestPhone ? 'Guest buyer' : undefined,
        status: order.status ?? 'CONFIRMED',
        currency: 'GHS',
        pricingVersion: 6,
        grandTotal: order.grandTotal,
        subtotal: new Prisma.Decimal(line.unitListPrice).mul(line.quantity),
        discountTotal: new Prisma.Decimal(line.unitListPrice)
          .mul(line.quantity)
          .sub(line.lineTotal)
          .sub(line.share ?? '0'),
        shippingTotal: order.shippingTotal ?? '0',
        taxTotal: order.taxTotal ?? '0',
        paymentMethod: order.paymentMethod ?? PaymentMethod.ONLINE,
        contactEmail: order.guestPhone ? null : 'buyer@example.com',
        contactPhone: '+233244111222',
        createdAt: order.createdAt,
        adjustments: { createMany: { data: order.adjustments ?? [] } },
        items: {
          create: {
            productId: line.productId,
            variantId: line.variantId,
            productName: line.productId,
            quantity: line.quantity,
            unitListPrice: line.unitListPrice,
            unitDiscount: line.unitDiscount ?? '0',
            unitNet: line.unitNet,
            unitTax: line.unitTax,
            lineTotal: line.lineTotal,
            orderAdjustmentShare: line.share ?? '0',
            unitCost: line.unitCost,
            costRecordedAt: order.createdAt,
          },
        },
      },
      include: { items: true },
    });
    orderIds[key] = created.id;
    lineIds[key] = created.items[0].id;
    return created.id;
  };

  const payOnline = (key: string, paidAt: Date, amountPaid: number) =>
    seedPaymentAttempt(prisma, {
      orderId: orderIds[key],
      status: PaymentStatus.CAPTURED,
      amount: amountPaid,
      updatedAt: paidAt,
    });

  const refund = async (
    key: string,
    attemptId: string,
    processedAt: Date,
    values: { amount: string; taxAmount: string; quantity: number; shippingAmount?: string },
  ) =>
    prisma.refund.create({
      data: {
        attemptId,
        amount: values.amount,
        taxAmount: values.taxAmount,
        shippingAmount: values.shippingAmount ?? '0',
        status: 'PROCESSED',
        idempotencyKey: `analytics-${key}-${processedAt.getTime()}`,
        reason: 'CUSTOMER_REQUEST',
        method: 'PROVIDER',
        createdAt: processedAt,
        updatedAt: processedAt,
        lines: {
          create: {
            orderItemId: lineIds[key],
            quantity: values.quantity,
            amount: new Prisma.Decimal(values.amount).sub(values.shippingAmount ?? '0'),
          },
        },
      },
    });

  const V1: Omit<LineSpec, 'quantity' | 'lineTotal'> = {
    variantId: 'ana_var1',
    productId: 'ana_prod1',
    unitListPrice: '50.00',
    unitNet: '40.00',
    unitTax: '10.00',
    unitCost: '15.0000',
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    rollups = app.get(AnalyticsRollupService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    ownerToken = await signInSuperAdmin(app);

    // Staff who read reports but not costs.
    const reporterEmail = 'reporter-analytics@test.local';
    ({ accessToken: reporterToken } = await signUpUser(app, {
      email: reporterEmail,
      password: 'Str0ng!Passw0rd',
      name: 'Reporter',
    }));
    const reporter = await prisma.user.findUniqueOrThrow({ where: { email: reporterEmail } });
    const role = await prisma.staffRole.create({
      data: { key: 'ANALYTICS_REPORTER', name: 'Reporter', permissions: ['report.view', 'order.view'] },
    });
    const store = await prisma.store.findFirstOrThrow();
    await prisma.storeMembership.create({ data: { userId: reporter.id, storeId: store.id, roleId: role.id } });

    locationId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    await prisma.category.createMany({
      data: [
        { id: 'ana_cat_a', name: 'Kitchen' },
        { id: 'ana_cat_b', name: 'Garden' },
      ],
    });
    for (const [index, categoryId] of ['ana_cat_a', 'ana_cat_b'].entries()) {
      await prisma.product.create({
        data: {
          id: `ana_prod${index + 1}`,
          name: `Analytics product ${index + 1}`,
          images: [],
          isActive: true,
          status: index === 1 ? 'ARCHIVED' : 'PUBLISHED',
          categoryId,
          variants: { create: { id: `ana_var${index + 1}`, sku: `ANA-${index + 1}`, price: 50, basePrice: 40 } },
        },
      });
    }
    await prisma.user.create({ data: { id: 'ana_user2', email: 'ana-user2@example.com', name: 'Second' } });
    const coupon = await createCoupon(prisma, { code: 'SAVE10', type: 'AMOUNT_OFF', value: 10 });
    couponPromotionId = coupon.promotion.id;
    flashPromotionId = (await createPromotion(prisma, { name: 'Flash', type: 'AMOUNT_OFF', value: 5, unitCap: 10 })).id;

    // A, D1: paid online, coupon 10 off the cart, delivery 20. Ex-tax net 70, cost 2 x 15.
    await createOrder('A', {
      userId: 'seed_user',
      createdAt: at(D1, '08:00:00'),
      grandTotal: '110.00',
      shippingTotal: '20.00',
      taxTotal: '20.00',
      line: { ...V1, quantity: 2, lineTotal: '100.00', share: '-10.00' },
      adjustments: [{ type: 'COUPON', sourceId: couponPromotionId, code: 'SAVE10', amount: '-10.00' }],
    });
    await payOnline('A', at(D1), 110);
    await prisma.redemption.create({
      data: { promotionId: couponPromotionId, customerId: 'seed_user', orderId: orderIds.A, units: 0 },
    });

    // B, D1: guest, flash sale 5 off the unit, 5 paid with loyalty points; cost unknown. Ex-tax net 20.
    await createOrder('B', {
      guestPhone: '+233244999888',
      createdAt: at(D1, '09:00:00'),
      grandTotal: '20.00',
      line: {
        variantId: 'ana_var2',
        productId: 'ana_prod2',
        quantity: 1,
        unitListPrice: '30.00',
        unitDiscount: '5.00',
        unitNet: '25.00',
        unitTax: '0.00',
        lineTotal: '25.00',
        share: '-5.00',
        unitCost: null,
      },
      adjustments: [
        { type: 'DISCOUNT', sourceId: flashPromotionId, amount: '-5.00' },
        { type: 'LOYALTY_POINTS', amount: '-5.00' },
      ],
    });
    await prisma.orderAdjustment.updateMany({
      where: { orderId: orderIds.B, type: 'DISCOUNT' },
      data: { orderItemId: lineIds.B },
    });
    await payOnline('B', at(D1, '12:00:00'), 20);
    await prisma.redemption.create({ data: { promotionId: flashPromotionId, orderId: orderIds.B, units: 1 } });

    // C: cash on delivery, placed D1, cash collected D2. Delivery 10.
    await createOrder('C', {
      userId: 'seed_user',
      createdAt: at(D1, '09:30:00'),
      grandTotal: '60.00',
      shippingTotal: '10.00',
      taxTotal: '10.00',
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      status: 'COMPLETED',
      line: { ...V1, quantity: 1, lineTotal: '50.00' },
    });
    const codIntent = await prisma.paymentIntent.create({
      data: { orderId: orderIds.C, amount: 60, status: 'CAPTURED' },
    });
    const codAttempt = await prisma.paymentAttempt.create({
      data: {
        intentId: codIntent.id,
        provider: PaymentProvider.CASH_ON_DELIVERY,
        channel: PaymentProvider.CASH_ON_DELIVERY,
        amount: 60,
        status: PaymentStatus.CAPTURED,
      },
    });
    await prisma.cashCollection.create({
      data: { orderId: orderIds.C, attemptId: codAttempt.id, amount: 60, collectedAt: at(D2, '15:00:00') },
    });

    // D, D2: paid online; one of its two units refunded on D3 and put back on the shelf.
    await createOrder('D', {
      userId: 'ana_user2',
      createdAt: at(D2, '08:00:00'),
      grandTotal: '100.00',
      taxTotal: '20.00',
      line: { ...V1, quantity: 2, lineTotal: '100.00' },
    });
    const { paymentId: paymentD } = await payOnline('D', at(D2), 100);
    await refund('D', paymentD, at(D3), { amount: '50.00', taxAmount: '10.00', quantity: 1 });
    await prisma.stockMovement.create({
      data: {
        variantId: 'ana_var1',
        locationId,
        onHandDelta: 1,
        reservedDelta: 0,
        reason: 'RETURN_RESTOCK',
        refType: 'Order',
        refId: orderIds.D,
        createdAt: at(D3, '11:00:00'),
      },
    });

    // E, D2: paid online and refunded in full the same day (goods damaged, not restocked).
    await createOrder('E', {
      userId: 'ana_user2',
      createdAt: at(D2, '09:00:00'),
      grandTotal: '50.00',
      taxTotal: '10.00',
      status: 'COMPLETED',
      line: { ...V1, quantity: 1, lineTotal: '50.00' },
    });
    const { paymentId: paymentE } = await payOnline('E', at(D2, '11:00:00'), 50);
    await refund('E', paymentE, at(D2, '18:00:00'), { amount: '50.00', taxAmount: '10.00', quantity: 1 });

    // Placed on D1 but never paid, and cancelled before payment: placed, never sales.
    await createOrder('F', {
      userId: 'seed_user',
      createdAt: at(D1, '13:00:00'),
      grandTotal: '50.00',
      status: 'PLACED',
      line: { ...V1, quantity: 1, lineTotal: '50.00', unitCost: null },
    });
    await seedPaymentAttempt(prisma, { orderId: orderIds.F, status: PaymentStatus.PENDING, amount: 50 });
    await createOrder('G', {
      userId: 'seed_user',
      createdAt: at(D1, '14:00:00'),
      grandTotal: '50.00',
      status: 'CANCELLED',
      line: { ...V1, quantity: 1, lineTotal: '50.00', unitCost: null },
    });

    // I, February: the first customer orders again.
    await createOrder('I', {
      userId: 'seed_user',
      createdAt: at(FEB, '08:00:00'),
      grandTotal: '30.00',
      line: {
        variantId: 'ana_var2',
        productId: 'ana_prod2',
        quantity: 1,
        unitListPrice: '30.00',
        unitNet: '30.00',
        unitTax: '0.00',
        lineTotal: '30.00',
        unitCost: null,
      },
    });
    await payOnline('I', at(FEB), 30);

    // The funnel counters of D1, as the cart and checkout interceptors leave them in Redis.
    const redis = app.get<Redis>(REDIS_CLIENT);
    await redis.set(`analytics:carts_started:${D1}`, '6');
    await redis.set(`analytics:checkout_quotes:${D1}`, '8');

    await rollups.rebuild({ from: day(D1), to: day('2026-01-08') });
    await rollups.rebuild({ from: day(FEB), to: day('2026-02-11') });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  const SALES = `paidOrders unitsSold grossRevenue ${M} itemSales ${M} itemDiscounts ${M} orderDiscounts ${M}
    loyaltyDiscounts ${M} shipping ${M} shippingDiscounts ${M} tax ${M} refundCount refunds ${M} refundedTax ${M}
    netRevenue ${M} averageOrderValue ${M}`;
  const salesReport = (bucket: string) =>
    gql<{ salesReport: Record<string, unknown> & { buckets: Record<string, unknown>[] } }>(
      `{ salesReport(firstDay: "${D1}", lastDay: "${D3}", bucket: ${bucket}) {
        totals { ${SALES} } buckets { firstDay lastDay ${SALES} } refreshedAt daysNotComputed } }`,
    ).then((data) => data.salesReport);

  it('reports sales by the day each order was paid and refunds by the day they were processed', async () => {
    const report = await salesReport('DAY');

    expect(report.daysNotComputed).toBe(0);
    expect(report.refreshedAt).not.toBeNull();
    expect(report.buckets).toEqual([
      expect.objectContaining({
        firstDay: D1,
        paidOrders: 2,
        unitsSold: 3,
        grossRevenue: amount('130.00'),
        itemSales: amount('110.00'),
        itemDiscounts: amount('5.00'),
        orderDiscounts: amount('10.00'),
        loyaltyDiscounts: amount('5.00'),
        shipping: amount('20.00'),
        tax: amount('20.00'),
        refunds: amount('0.00'),
        netRevenue: amount('130.00'),
        averageOrderValue: amount('65.00'),
      }),
      expect.objectContaining({
        firstDay: D2,
        paidOrders: 3,
        unitsSold: 4,
        grossRevenue: amount('210.00'),
        shipping: amount('10.00'),
        tax: amount('40.00'),
        refundCount: 1,
        refunds: amount('50.00'),
        refundedTax: amount('10.00'),
        netRevenue: amount('160.00'),
      }),
      expect.objectContaining({
        firstDay: D3,
        paidOrders: 0,
        refundCount: 1,
        refunds: amount('50.00'),
        netRevenue: amount('-50.00'),
        averageOrderValue: amount('0.00'),
      }),
    ]);
    expect(report.totals).toMatchObject({
      paidOrders: 5,
      unitsSold: 7,
      grossRevenue: amount('340.00'),
      refunds: amount('100.00'),
      netRevenue: amount('240.00'),
      averageOrderValue: amount('48.00'),
    });
  });

  it('groups days into weeks cut to the range, with the same totals', async () => {
    const report = await salesReport('WEEK');

    expect(report.buckets).toEqual([
      expect.objectContaining({ firstDay: D1, lastDay: D3, paidOrders: 5, netRevenue: amount('240.00') }),
    ]);
  });

  it('reports margins from the snapshotted costs, unknown costs apart and the restock reversing its cost', async () => {
    const { marginReport } = await gql<{ marginReport: Record<string, unknown> }>(
      `{ marginReport(firstDay: "${D1}", lastDay: "${D3}") {
        overall { unitsSold netSales ${M} costedNetSales ${M} cogs ${M} grossMargin ${M} marginRate unknownCostUnits unknownCostNetSales ${M} }
        byProduct { productId archived grossMargin ${M} marginRate unknownCostUnits }
        byCategory { categoryName grossMargin ${M} }
        unallocatedRefunds ${M} } }`,
    );

    // Kitchen: 70 (D1) + 160 - 40 (D2, E refunded) - 40 (D3, D's unit) = 150 net; cost 30 + 60 - 15 (restocked) = 75.
    expect(marginReport).toEqual({
      overall: {
        unitsSold: 7,
        netSales: amount('170.00'),
        costedNetSales: amount('150.00'),
        cogs: amount('75.00'),
        grossMargin: amount('75.00'),
        marginRate: '0.5',
        unknownCostUnits: 1,
        unknownCostNetSales: amount('20.00'),
      },
      byProduct: [
        {
          productId: 'ana_prod1',
          archived: false,
          grossMargin: amount('75.00'),
          marginRate: '0.5',
          unknownCostUnits: 0,
        },
        { productId: 'ana_prod2', archived: true, grossMargin: amount('0.00'), marginRate: null, unknownCostUnits: 1 },
      ],
      byCategory: [
        { categoryName: 'Kitchen', grossMargin: amount('75.00') },
        { categoryName: 'Garden', grossMargin: amount('0.00') },
      ],
      unallocatedRefunds: amount('0.00'),
    });
  });

  it('keeps margins when a cost changes later, until and after a rebuild', async () => {
    await prisma.variant.update({ where: { id: 'ana_var1' }, data: { costPrice: '40.0000' } });
    await rollups.rebuild({ from: day(D1), to: day('2026-01-08') });

    const { marginReport } = await gql<{ marginReport: { overall: { cogs: unknown } } }>(
      `{ marginReport(firstDay: "${D1}", lastDay: "${D3}") { overall { cogs ${M} } } }`,
    );
    expect(marginReport.overall.cogs).toEqual(amount('75.00'));
  });

  it('ranks top products and categories of paid orders, labelling archived products', async () => {
    const data = await gql<{ topProducts: unknown[]; topCategories: unknown[] }>(
      `{
        topProducts(firstDay: "${D1}", lastDay: "${D3}") { productId archived unitsSold unitsRefunded sales ${M} refunds ${M} netSales ${M} }
        topCategories(firstDay: "${D1}", lastDay: "${D3}") { categoryId categoryName unitsSold sales ${M} netSales ${M} }
      }`,
    );

    expect(data.topProducts).toEqual([
      {
        productId: 'ana_prod1',
        archived: false,
        unitsSold: 6,
        unitsRefunded: 2,
        sales: amount('290.00'),
        refunds: amount('100.00'),
        netSales: amount('190.00'),
      },
      {
        productId: 'ana_prod2',
        archived: true,
        unitsSold: 1,
        unitsRefunded: 0,
        sales: amount('20.00'),
        refunds: amount('0.00'),
        netSales: amount('20.00'),
      },
    ]);
    expect(data.topCategories).toEqual([
      {
        categoryId: 'ana_cat_a',
        categoryName: 'Kitchen',
        unitsSold: 6,
        sales: amount('290.00'),
        netSales: amount('190.00'),
      },
      {
        categoryId: 'ana_cat_b',
        categoryName: 'Garden',
        unitsSold: 1,
        sales: amount('20.00'),
        netSales: amount('20.00'),
      },
    ]);
  });

  it('reports coupon and promotion performance on paid orders', async () => {
    const { promotionPerformance } = await gql<{ promotionPerformance: unknown[] }>(
      `{ promotionPerformance(firstDay: "${D1}", lastDay: "${D3}") {
        promotionId promotionName couponCode orders discount ${M} revenue ${M} units } }`,
    );

    expect(promotionPerformance).toEqual([
      {
        promotionId: couponPromotionId,
        promotionName: 'Coupon SAVE10',
        couponCode: 'SAVE10',
        orders: 1,
        discount: amount('10.00'),
        revenue: amount('110.00'),
        units: 0,
      },
      {
        promotionId: flashPromotionId,
        promotionName: 'Flash',
        couponCode: null,
        orders: 1,
        discount: amount('5.00'),
        revenue: amount('20.00'),
        units: 1,
      },
    ]);
  });

  it('reports the checkout funnel from the counters and the orders', async () => {
    const { conversionReport } = await gql<{ conversionReport: { totals: unknown } }>(
      `{ conversionReport(firstDay: "${D1}", lastDay: "${D2}") { totals {
        cartsStarted checkoutQuotes ordersPlaced paidOrders quoteRate placementRate paymentRate conversionRate } } }`,
    );

    // Placed on D1: A, B, C, F, G; on D2: D, E. Paid: A, B on D1; C, D, E on D2.
    expect(conversionReport.totals).toEqual({
      cartsStarted: 6,
      checkoutQuotes: 8,
      ordersPlaced: 7,
      paidOrders: 5,
      quoteRate: 1.3333,
      placementRate: 0.875,
      paymentRate: 0.7143,
      conversionRate: 0.8333,
    });
  });

  it('groups customers, guests included, into cohorts by their first paid month', async () => {
    const { cohortReport } = await gql<{ cohortReport: unknown[] }>(
      `{ cohortReport(firstMonth: "2026-01", lastMonth: "2026-02", followMonths: 2) {
        month customers repeatCustomers repeatRate months { offset activeCustomers orders netRevenue ${M} } } }`,
    );

    const empty = (offset: number) => ({ offset, activeCustomers: 0, orders: 0, netRevenue: amount('0.00') });
    expect(cohortReport).toEqual([
      {
        month: '2026-01',
        customers: 3,
        repeatCustomers: 2,
        repeatRate: 0.6667,
        months: [
          { offset: 0, activeCustomers: 3, orders: 5, netRevenue: amount('240.00') },
          { offset: 1, activeCustomers: 1, orders: 1, netRevenue: amount('30.00') },
          empty(2),
        ],
      },
      { month: '2026-02', customers: 0, repeatCustomers: 0, repeatRate: null, months: [empty(0), empty(1), empty(2)] },
    ]);
  });

  it('values stock on hand at cost, counting variants without a cost apart', async () => {
    const valuation = () =>
      gql<{
        inventoryValuation: {
          units: number;
          value: { amount: string };
          unknownCostUnits: number;
          unknownCostVariants: number;
        };
      }>(`{ inventoryValuation { units value ${M} unknownCostUnits unknownCostVariants } }`).then(
        (data) => data.inventoryValuation,
      );
    // The seeded catalogue may hold stock already: compare with what was there.
    const before = await valuation();
    await prisma.stockLevel.createMany({
      data: [
        { variantId: 'ana_var1', locationId, onHand: 4, reserved: 0 },
        { variantId: 'ana_var2', locationId, onHand: 3, reserved: 0 },
      ],
    });

    const after = await valuation();

    // ana_var1 costs 40 since the earlier cost change; ana_var2 has no cost.
    expect({
      units: after.units - before.units,
      value: new Prisma.Decimal(after.value.amount).sub(before.value.amount).toFixed(2),
      unknownCostUnits: after.unknownCostUnits - before.unknownCostUnits,
      unknownCostVariants: after.unknownCostVariants - before.unknownCostVariants,
    }).toEqual({ units: 7, value: '160.00', unknownCostUnits: 3, unknownCostVariants: 1 });
  });

  it('hides costs from staff without inventory.cost.view, but not the other reports', async () => {
    const margin = await gqlErrors(
      `{ marginReport(firstDay: "${D1}", lastDay: "${D3}") { overall { cogs ${M} } } }`,
      reporterToken,
    );
    const valuation = await gqlErrors(`{ inventoryValuation { units } }`, reporterToken);
    const lineCost = await gqlRequest(
      app,
      `{ viewOrder(id: "${orderIds.A}") { items { unitCost } } }`,
      undefined,
      reporterToken,
    ).expect(200);
    const ownerLineCost = await gql<{ viewOrder: { items: { unitCost: string }[] } }>(
      `{ viewOrder(id: "${orderIds.A}") { items { unitCost } } }`,
    );
    const sales = await gql<{ salesReport: { totals: { paidOrders: number } } }>(
      `{ salesReport(firstDay: "${D1}", lastDay: "${D3}") { totals { paidOrders } } }`,
      reporterToken,
    );

    expect(margin.map((error) => error.extensions.code)).toEqual(['FORBIDDEN']);
    expect(valuation.map((error) => error.extensions.code)).toEqual(['FORBIDDEN']);
    expect(lineCost.body.errors.map((error: { extensions: { code: string } }) => error.extensions.code)).toEqual([
      'FORBIDDEN',
    ]);
    expect(ownerLineCost.viewOrder.items).toEqual([{ unitCost: '15' }]);
    expect(sales.salesReport.totals.paidOrders).toBe(5);
  });

  it('refuses invalid ranges with BAD_REQUEST', async () => {
    const reversed = await gqlErrors(`{ salesReport(firstDay: "${D2}", lastDay: "${D1}") { daysNotComputed } }`);
    const tooLong = await gqlErrors(
      `{ salesReport(firstDay: "2024-01-01", lastDay: "2026-01-01") { daysNotComputed } }`,
    );
    const impossible = await gqlErrors(`{ topProducts(firstDay: "2026-02-30", lastDay: "2026-03-01") { productId } }`);
    const malformed = await gqlErrors(`{ salesReport(firstDay: "5 Jan", lastDay: "${D1}") { daysNotComputed } }`);
    const cohorts = await gqlErrors(`{ cohortReport(firstMonth: "2024-01", lastMonth: "2026-01") { month } }`);

    expect([reversed, tooLong, impossible, cohorts].map((errors) => errors[0]?.extensions.code)).toEqual([
      'BAD_REQUEST',
      'BAD_REQUEST',
      'BAD_REQUEST',
      'BAD_REQUEST',
    ]);
    expect(malformed[0]?.extensions.code).toBe('BAD_USER_INPUT');
  });

  it('queues a rebuild for staff with jobs.manage, audited, and refuses it to others', async () => {
    const { rebuildAnalytics } = await gql<{ rebuildAnalytics: { jobId: string; firstDay: string } }>(
      `mutation { rebuildAnalytics(input: { firstDay: "${D1}", lastDay: "${D3}" }) { jobId firstDay lastDay } }`,
    );
    const refused = await gqlErrors(
      `mutation { rebuildAnalytics(input: { firstDay: "${D1}", lastDay: "${D3}" }) { jobId } }`,
      reporterToken,
    );

    expect(rebuildAnalytics).toMatchObject({ firstDay: D1 });
    expect(
      await prisma.auditLog.count({ where: { entity: 'AnalyticsRollup', entityId: rebuildAnalytics.jobId } }),
    ).toBe(1);
    expect(refused[0]?.extensions.code).toBe('FORBIDDEN');
  });

  it('gives the same rows when a day is rebuilt again, and picks up a late refund on its day', async () => {
    const before = await salesReport('DAY');
    await rollups.rebuild({ from: day(D1), to: day('2026-01-08') });
    const again = await salesReport('DAY');

    const codAttempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { intent: { orderId: orderIds.C } },
    });
    await refund('C', codAttempt.id, at(D3, '16:00:00'), {
      amount: '60.00',
      taxAmount: '10.00',
      quantity: 1,
      shippingAmount: '10.00',
    });
    await rollups.rebuild({ from: day(D3), to: day('2026-01-08') });
    const late = await salesReport('DAY');

    expect({ ...again, refreshedAt: null }).toEqual({ ...before, refreshedAt: null });
    expect(late.buckets[2]).toMatchObject({ refundCount: 2, refunds: amount('110.00'), netRevenue: amount('-110.00') });
    expect(late.buckets[1]).toEqual(before.buckets[1]);
    expect(await prisma.analyticsDailyVariant.count({ where: { day: day(D3) } })).toBe(1);
  });
});
