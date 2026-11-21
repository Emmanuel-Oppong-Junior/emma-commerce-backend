import { BadRequestException, ConflictException, INestApplication } from '@nestjs/common';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal, stockOf } from '../helpers/db.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';
import { createCoupon } from '../helpers/promotion.helper';

const PRODUCT_ID = 'seed_prod2';
const VARIANT_ID = 'seed_var2';
const SHOPPERS = 20;
const USAGE_LIMIT = 10;

describe('Coupon usage limits and release (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;

  const shopperId = (n: number) => `coupon_shopper_${n}`;

  const createShoppers = async (count: number) => {
    await prisma.user.createMany({
      data: Array.from({ length: count }, (_, n) => ({ id: shopperId(n), email: `shopper${n}@example.com` })),
    });
  };

  const checkout = async (userId: string, couponCode: string) => {
    const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1 },
    });
    return placeOrderFromCart(orders, userId, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: await addressFor(userId),
      contactEmail: 'shopper@example.com',
      contactPhone: '+233244000000',
      couponCode,
    });
  };

  const addressFor = async (userId: string) => {
    const existing = await prisma.address.findFirst({ where: { userId } });
    if (existing) return existing.id;
    const created = await prisma.address.create({
      data: {
        userId,
        street: '1 Promo St',
        city: 'Accra',
        recipientName: 'Test Customer',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    return created.id;
  };

  const couponState = async (code: string) => {
    const couponCode = await prisma.couponCode.findUniqueOrThrow({ where: { code }, include: { promotion: true } });
    const usages = await prisma.redemption.count({ where: { couponCodeId: couponCode.id, status: 'RESERVED' } });
    return { usedCount: couponCode.promotion.usedCount, usages };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await createShoppers(SHOPPERS);
  });

  afterAll(async () => {
    await app.close();
  });

  it(`${SHOPPERS} parallel checkouts on a ${USAGE_LIMIT}-use coupon create exactly ${USAGE_LIMIT} orders`, async () => {
    await createCoupon(prisma, { code: 'FIRST10', type: 'AMOUNT_OFF', value: 10, usageLimit: USAGE_LIMIT });
    for (let n = 0; n < SHOPPERS; n++) {
      const cart = await prisma.cart.upsert({
        where: { userId: shopperId(n) },
        create: { userId: shopperId(n) },
        update: {},
      });
      await prisma.cartItem.create({
        data: { cartId: cart.id, productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1 },
      });
      await addressFor(shopperId(n));
    }
    const stockBefore = (await stockOf(prisma, VARIANT_ID)).available;

    const results = await Promise.allSettled(
      Array.from({ length: SHOPPERS }, async (_, n) =>
        placeOrderFromCart(orders, shopperId(n), {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: await addressFor(shopperId(n)),
          contactEmail: 'shopper@example.com',
          contactPhone: '+233244000000',
          couponCode: 'FIRST10',
        }),
      ),
    );

    const placed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(placed).toHaveLength(USAGE_LIMIT);
    // Refused either while pricing (the coupon already shows no use left) or at placement, when the conditional
    // increment of the promotion's uses finds none left (CONFLICT PROMOTION_LIMIT_REACHED).
    for (const r of refused) {
      if (r.reason instanceof ConflictException) {
        expect(r.reason.getResponse()).toMatchObject({ extensions: { reason: 'PROMOTION_LIMIT_REACHED' } });
      } else {
        expect(r.reason).toBeInstanceOf(BadRequestException);
      }
    }
    expect(await prisma.order.count({ where: { couponCode: { code: 'FIRST10' } } })).toBe(USAGE_LIMIT);
    expect(await couponState('FIRST10')).toEqual({ usedCount: USAGE_LIMIT, usages: USAGE_LIMIT });
    const stockAfter = (await stockOf(prisma, VARIANT_ID)).available;
    expect(stockAfter).toBe(stockBefore - USAGE_LIMIT);
  });

  it('cancelling an order gives the coupon use back, so the customer can use the code again', async () => {
    await createCoupon(prisma, { code: 'ONCE', type: 'AMOUNT_OFF', value: 5, usageLimit: 1 });
    const userId = shopperId(0);
    await prisma.cartItem.deleteMany({ where: { cart: { userId } } });
    const first = await checkout(userId, 'ONCE');
    expect(await couponState('ONCE')).toEqual({ usedCount: 1, usages: 1 });

    await orders.cancelOrder(userId, first.id);

    expect(await couponState('ONCE')).toEqual({ usedCount: 0, usages: 0 });
    const second = await checkout(userId, 'ONCE');
    expect(second.couponCodeId).toBeTruthy();
    expect(await couponState('ONCE')).toEqual({ usedCount: 1, usages: 1 });
  });

  it('expiring an abandoned order gives the coupon use back', async () => {
    await createCoupon(prisma, { code: 'EXPIRE5', type: 'AMOUNT_OFF', value: 5, usageLimit: 5 });
    const userId = shopperId(1);
    await prisma.cartItem.deleteMany({ where: { cart: { userId } } });
    const order = await checkout(userId, 'EXPIRE5');
    await prisma.order.update({
      where: { id: order.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    await orders.expireAbandonedOrders(1);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('EXPIRED');
    expect(await couponState('EXPIRE5')).toEqual({ usedCount: 0, usages: 0 });
  });
});
