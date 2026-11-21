import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock } from '../helpers/db.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const M = '{ amount currency }';
const sum = (values: Prisma.Decimal[]) => values.reduce((total, value) => total.add(value), new Prisma.Decimal(0));

describe('Order totals, line snapshots and tax lines (P1-O.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(),
    createRefund: jest.fn(async () => ({ id: 'rf_totals', status: 'pending' })),
  };

  const placeOrder = async (): Promise<string> => {
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Totals St',
        city: 'Accra',
        country: 'GH',
      },
    });
    for (const [variantId, quantity] of [
      ['totals_kente_var', 2],
      ['seed_var2', 1],
    ] as const) {
      const res = await gqlRequest(
        app,
        `mutation { addToCart(input: { variantId: "${variantId}", quantity: ${quantity} }) { id } }`,
        undefined,
        userToken,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();
    }
    const res = await gqlRequest(
      app,
      `mutation { createOrder(input: { fulfillmentType: DELIVERY, shippingAddressId: "${address.id}", contactEmail: "user@example.com", contactPhone: "+233244000000", couponCode: "TOTALS20" }) {
        id currency pricingVersion subtotal ${M} discountTotal ${M} taxTotal ${M} shippingTotal ${M} grandTotal ${M}
        adjustments { type orderItemId sourceId code amount ${M} }
        items { id productName sku unitListPrice ${M} unitDiscount ${M} unitNet ${M} unitTax ${M} lineTotal ${M}
          taxLines { name rate base ${M} amount ${M} } }
      } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.createOrder.id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.tax.createMany({
      data: [
        { id: 'totals_vat', name: 'VAT', rate: '0.15' },
        { id: 'totals_nhil', name: 'NHIL', rate: '0.025' },
      ],
    });
    // A taxable product priced the way the catalogue prices it: basePrice 100 x (1 + 0.175) = 117.50.
    await prisma.product.create({
      data: {
        id: 'totals_kente',
        name: 'Kente cloth',
        images: [],
        isActive: true,
        isTaxable: true,
        status: 'PUBLISHED',
        variants: {
          create: [{ id: 'totals_kente_var', sku: 'KENTE-TOTALS', optionsKey: '', price: '117.50', basePrice: 100 }],
        },
      },
    });
    await setStock(prisma, 'totals_kente_var', 10);
    await prisma.discount.create({
      data: {
        id: 'totals_disc10',
        name: 'Kente week',
        type: 'PERCENTAGE',
        value: 10,
        isActive: true,
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 86_400_000),
        products: { connect: { id: 'totals_kente' } },
      },
    });
    await prisma.coupon.create({ data: { id: 'totals_coupon', code: 'TOTALS20', discountType: 'FLAT', value: 20 } });
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('a placed order with a product discount, a coupon, tax and shipping', () => {
    let orderId: string;

    beforeAll(async () => {
      orderId = await placeOrder();
    });

    it('stores lines, adjustments, tax and shipping that add up to the grand total (Σ lines + adjustments + tax + shipping)', async () => {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: { include: { taxLines: true } }, adjustments: true },
      });
      const lineNets = sum(order.items.map((item) => item.unitNet!.mul(item.quantity)));
      const orderAdjustments = sum(order.adjustments.filter((a) => a.orderItemId === null).map((a) => a.amount));
      const taxLines = sum(order.items.flatMap((item) => item.taxLines.map((line) => line.amount)));

      expect(order).toMatchObject({ currency: 'GHS', pricingVersion: 1 });
      expect(lineNets.add(orderAdjustments).add(taxLines).add(order.shippingTotal!).toFixed(2)).toBe(
        order.grandTotal.toFixed(2),
      );
      expect(taxLines.toFixed(2)).toBe(order.taxTotal!.toFixed(2));
      expect(order.subtotal!.sub(order.discountTotal!).add(order.shippingTotal!).toFixed(2)).toBe(
        order.grandTotal.toFixed(2),
      );
      expect(
        sum(order.adjustments.map((a) => a.amount))
          .neg()
          .toFixed(2),
      ).toBe(order.discountTotal!.toFixed(2));
      // 117.50 - 11.75 = 105.75 a unit, of which 15.75 tax; the phone has no tax. 211.50 + 499.99 - 20 + 15.
      expect(
        [order.subtotal, order.discountTotal, order.taxTotal, order.shippingTotal, order.grandTotal].map((v) =>
          v!.toFixed(2),
        ),
      ).toEqual(['734.99', '43.50', '31.50', '15.00', '706.49']);
    });

    it('exposes the snapshot on the order, with one tax line per active tax on the taxable line only', async () => {
      const res = await gqlRequest(
        app,
        `query { order(orderId: "${orderId}") { grandTotal ${M} taxTotal ${M}
          adjustments { type sourceId code amount ${M} }
          items { productName sku unitListPrice ${M} unitDiscount ${M} unitNet ${M} unitTax ${M} lineTotal ${M}
            taxLines { name rate base ${M} amount ${M} } } } }`,
        undefined,
        userToken,
      ).expect(200);

      expect(res.body.errors).toBeUndefined();
      const order = res.body.data.order;
      const kente = order.items.find((item: { sku: string }) => item.sku === 'KENTE-TOTALS');
      const phone = order.items.find((item: { sku: string }) => item.sku !== 'KENTE-TOTALS');
      expect(kente).toEqual({
        productName: 'Kente cloth',
        sku: 'KENTE-TOTALS',
        unitListPrice: ghs('117.50'),
        unitDiscount: ghs('11.75'),
        unitNet: ghs('90.00'),
        unitTax: ghs('15.75'),
        lineTotal: ghs('211.50'),
        taxLines: [
          { name: 'NHIL', rate: '0.025', base: ghs('180.00'), amount: ghs('4.50') },
          { name: 'VAT', rate: '0.15', base: ghs('180.00'), amount: ghs('27.00') },
        ],
      });
      expect(phone).toMatchObject({ unitTax: ghs('0.00'), unitNet: ghs('499.99'), taxLines: [] });
      expect(order.adjustments).toEqual(
        expect.arrayContaining([
          { type: 'DISCOUNT', sourceId: 'totals_disc10', code: null, amount: ghs('-23.50') },
          { type: 'COUPON', sourceId: 'totals_coupon', code: 'TOTALS20', amount: ghs('-20.00') },
        ]),
      );
    });

    it('charges exactly the grand total', async () => {
      await request(app.getHttpServer())
        .post('/payment/initialize')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ orderId, paymentMethod: 'card' })
        .expect(201);

      const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId } });
      expect(intent.amount.toFixed(2)).toBe('706.49');
      expect(paystack.initializeTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({ amount: 70649, currency: 'GHS' }),
      );
    });

    it('refunds the tax read from the stored tax lines, even after the rates changed', async () => {
      await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } });
      await prisma.tax.update({ where: { id: 'totals_vat' }, data: { rate: '0.2' } });
      await seedPaymentAttempt(prisma, { orderId, status: 'CAPTURED', amount: 706.49 });
      const returned = await prisma.returnRequest.create({
        data: { orderId, userId: 'seed_user', reason: 'Wrong colour', status: 'APPROVED', refundAmount: 100 },
      });

      const res = await gqlRequest(
        app,
        `mutation { processRefund(returnRequestId: "${returned.id}") { id status } }`,
        undefined,
        adminToken,
      ).expect(200);

      expect(res.body.errors).toBeUndefined();
      const refund = await prisma.refund.findUniqueOrThrow({ where: { returnRequestId: returned.id } });
      // 31.50 x 100 / 706.49 = 4.4587..., from the stored lines; a recompute at 20% VAT would differ.
      expect(refund.taxAmount?.toFixed(2)).toBe('4.46');
    });
  });

  describe('migration of orders placed before the snapshot', () => {
    const BEFORE = '20261122010000_stock_ledger_contract';
    const EXPAND = '20261123000000_order_totals';
    const CONTRACT = '20261123010000_order_totals_contract';
    let legacy: ScratchSchema;

    const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-totals@test.local', now());
INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "updatedAt") VALUES ('v1', 'p1', 'MUG', '', 100, now());
INSERT INTO "Discount" ("id", "name", "type", "value", "startDate", "endDate", "updatedAt")
  VALUES ('d1', 'Old sale', 'PERCENTAGE', 10, now(), now(), now());
INSERT INTO "Coupon" ("id", "code", "discountType", "value", "updatedAt") VALUES ('c1', 'OLD10', 'FLAT', 10, now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "subtotal", "discountTotal", "shippingFee", "totalAmount", "couponId",
                     "couponDiscount", "status", "contactEmail", "contactPhone", "updatedAt") VALUES
  ('o_full', 1, 'u1', 180, 20, 15, 185, 'c1', 10, 'DELIVERED', 'legacy-totals@test.local', '+233200000000', now()),
  ('o_bare', 2, 'u1', NULL, NULL, NULL, 50, NULL, NULL, 'PENDING', 'legacy-totals@test.local', '+233200000000', now()),
  ('o_coupon_unknown', 3, 'u1', NULL, NULL, 0, 90, 'c1', NULL, 'CANCELLED', 'legacy-totals@test.local', '+233200000000', now());
INSERT INTO "OrderItem" ("id", "orderId", "productId", "variantId", "quantity", "priceAtOrder", "originalPrice",
                         "discountAmount", "discountId") VALUES
  ('oi_full', 'o_full', 'p1', 'v1', 2, 90, 100, 10, 'd1'),
  ('oi_bare', 'o_bare', 'p1', 'v1', 1, 50, 50, NULL, NULL),
  ('oi_coupon', 'o_coupon_unknown', 'p1', 'v1', 1, 100, 100, 0, NULL);
`;

    const orders = () =>
      legacy.query<Record<string, unknown>>(
        `SELECT id, currency::text, "pricingVersion", subtotal::text, "discountTotal"::text, "taxTotal"::text,
                "shippingTotal"::text, "grandTotal"::text
         FROM "Order" ORDER BY id`,
      );
    const items = () =>
      legacy.query<Record<string, unknown>>(
        `SELECT id, "productName", "unitListPrice"::text, "unitDiscount"::text, "unitNet"::text, "unitTax"::text,
                "lineTotal"::text
         FROM "OrderItem" ORDER BY id`,
      );
    const adjustments = () =>
      legacy.query<Record<string, unknown>>(
        `SELECT id, "orderId", "orderItemId", type::text, "sourceId", code, amount::text FROM "OrderAdjustment" ORDER BY id`,
      );
    const snapshot = async () => ({ orders: await orders(), items: await items(), adjustments: await adjustments() });

    beforeAll(async () => {
      legacy = new ScratchSchema(prisma, 'legacy_order_totals');
      await legacy.recreate();
      await legacy.migrateTo(BEFORE);
      await legacy.exec(LEGACY_DATA);
      await legacy.exec(migrationSql(EXPAND));
    });

    afterAll(async () => {
      await legacy.drop();
    });

    it('copies the totals each order stored, as pricingVersion 0, and invents no tax', async () => {
      expect(await orders()).toEqual([
        {
          id: 'o_bare',
          currency: 'GHS',
          pricingVersion: 0,
          subtotal: '50.00',
          discountTotal: '0.00',
          taxTotal: null,
          shippingTotal: null,
          grandTotal: '50.00',
        },
        {
          id: 'o_coupon_unknown',
          currency: 'GHS',
          pricingVersion: 0,
          subtotal: '100.00',
          discountTotal: null,
          taxTotal: null,
          shippingTotal: '0.00',
          grandTotal: '90.00',
        },
        {
          id: 'o_full',
          currency: 'GHS',
          pricingVersion: 0,
          subtotal: '200.00',
          discountTotal: '30.00',
          taxTotal: null,
          shippingTotal: '15.00',
          grandTotal: '185.00',
        },
      ]);
      expect(await legacy.query(`SELECT id FROM "OrderLineTax"`)).toEqual([]);
    });

    it('snapshots each line from what it stored, with no net or tax', async () => {
      expect(await items()).toEqual([
        {
          id: 'oi_bare',
          productName: 'Mug',
          unitListPrice: '50.00',
          unitDiscount: '0.00',
          unitNet: null,
          unitTax: null,
          lineTotal: '50.00',
        },
        {
          id: 'oi_coupon',
          productName: 'Mug',
          unitListPrice: '100.00',
          unitDiscount: '0.00',
          unitNet: null,
          unitTax: null,
          lineTotal: '100.00',
        },
        {
          id: 'oi_full',
          productName: 'Mug',
          unitListPrice: '100.00',
          unitDiscount: '10.00',
          unitNet: null,
          unitTax: null,
          lineTotal: '180.00',
        },
      ]);
    });

    it('turns stored product discounts and coupon discounts into adjustments', async () => {
      expect(await adjustments()).toEqual([
        {
          id: 'legacy_coupon_o_full',
          orderId: 'o_full',
          orderItemId: null,
          type: 'COUPON',
          sourceId: 'c1',
          code: 'OLD10',
          amount: '-10.00',
        },
        {
          id: 'legacy_discount_oi_full',
          orderId: 'o_full',
          orderItemId: 'oi_full',
          type: 'DISCOUNT',
          sourceId: 'd1',
          code: null,
          amount: '-20.00',
        },
      ]);
    });

    it('changes nothing when run again', async () => {
      const before = await snapshot();

      await legacy.exec(migrationSqlFrom(EXPAND, '-- Backfill'));

      expect(await snapshot()).toEqual(before);
    });

    it('then drops the old columns and requires a full breakdown on priced orders', async () => {
      await legacy.exec(migrationSql(CONTRACT));

      expect(
        await legacy.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'legacy_order_totals' AND column_name IN ('totalAmount', 'priceAtOrder', 'couponDiscount')`,
        ),
      ).toEqual([]);
      await expect(legacy.exec(`UPDATE "Order" SET "pricingVersion" = 1 WHERE id = 'o_bare'`)).rejects.toThrow(
        /Order_priced_totals_complete/,
      );
      await expect(legacy.exec(`UPDATE "OrderAdjustment" SET amount = 1`)).rejects.toThrow(
        /OrderAdjustment_reduction_not_positive/,
      );
    });
  });
});
