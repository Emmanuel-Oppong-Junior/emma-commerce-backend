import { INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ORDER_EXPIRY_LOCK_KEY, OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { clearPaymentLedger, resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';

const PRODUCT_ID = 'seed_prod2';
const USER_ID = 'seed_user';
const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

describe('Abandoned order expiry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let addressId: string;

  const stock = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID }, select: { quantity: true } })).quantity;
  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
  const restoreLogsFor = (orderId: string) =>
    prisma.inventoryLog.count({ where: { action: 'RETURN_RESTORE', reason: { contains: orderId } } });

  const placeOrder = async (quantity: number): Promise<string> => {
    const cart = await prisma.cart.upsert({ where: { userId: USER_ID }, create: { userId: USER_ID }, update: {} });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId: PRODUCT_ID, quantity } });
    const order = await orders.createOrderFromCart(USER_ID, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressId,
      contactEmail: 'user@example.com',
      contactPhone: '+233244000000',
    });
    return order.id;
  };

  const placeAbandonedOrder = async (quantity: number, paymentStatus?: PaymentStatus): Promise<string> => {
    const orderId = await placeOrder(quantity);
    await prisma.order.update({ where: { id: orderId }, data: { createdAt: TWO_HOURS_AGO() } });
    if (paymentStatus) await addPayment(orderId, paymentStatus, TWO_HOURS_AGO());
    return orderId;
  };

  const addPayment = async (orderId: string, status: PaymentStatus, touchedAt: Date) => {
    await seedPaymentAttempt(prisma, { orderId, status, updatedAt: touchedAt });
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    const address = await prisma.address.create({
      data: {
        userId: USER_ID,
        street: '1 Expiry St',
        city: 'Accra',
        recipientName: 'Test Customer',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        zipCode: '00233',
        country: 'GH',
      },
    });
    addressId = address.id;
  });

  beforeEach(async () => {
    await prisma.inventoryLog.deleteMany();
    await clearPaymentLedger(prisma);
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.update({ where: { id: PRODUCT_ID }, data: { quantity: 100 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('expires orders whose payment attempt is still pending or failed past the window, and releases their stock', async () => {
    const noAttempt = await placeAbandonedOrder(1);
    const pendingAttempt = await placeAbandonedOrder(2, PaymentStatus.PENDING);
    const failedAttempt = await placeAbandonedOrder(3, PaymentStatus.FAILED);

    const expired = await orders.expireAbandonedOrders(1);

    expect(expired).toBe(3);
    for (const orderId of [noAttempt, pendingAttempt, failedAttempt]) {
      expect(await statusOf(orderId)).toBe('CANCELLED');
    }
    expect(await stock()).toBe(100);
  });

  it('leaves alone a paid order, a fresh order and an order whose payment was started within the window', async () => {
    const paid = await placeAbandonedOrder(1, PaymentStatus.COMPLETED);
    const fresh = await placeOrder(1);
    const payingNow = await placeAbandonedOrder(1);
    await addPayment(payingNow, PaymentStatus.PENDING, new Date());

    const expired = await orders.expireAbandonedOrders(1);

    expect(expired).toBe(0);
    for (const orderId of [paid, fresh, payingNow]) {
      expect(await statusOf(orderId)).toBe('PENDING');
    }
    expect(await stock()).toBe(97);
  });

  it('two runners at once cancel each expired order once and restore its stock once', async () => {
    const orderIds = [
      await placeAbandonedOrder(1),
      await placeAbandonedOrder(2, PaymentStatus.PENDING),
      await placeAbandonedOrder(3, PaymentStatus.FAILED),
    ];
    expect(await stock()).toBe(94);

    const runs = await Promise.all([orders.expireAbandonedOrders(1), orders.expireAbandonedOrders(1)]);

    expect(runs.reduce<number>((sum, run) => sum + (run ?? 0), 0)).toBe(3);
    expect(await stock()).toBe(100);
    for (const orderId of orderIds) {
      expect(await statusOf(orderId)).toBe('CANCELLED');
      expect(await restoreLogsFor(orderId)).toBe(1);
    }
  });

  it('skips the run while another instance holds the expiry lock', async () => {
    const orderId = await placeAbandonedOrder(1);

    const [held, whileLocked] = await prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(${ORDER_EXPIRY_LOCK_KEY}::bigint) AS locked`;
      return [locked, await orders.expireAbandonedOrders(1)] as const;
    });

    expect(held).toBe(true);
    expect(whileLocked).toBeNull();
    expect(await statusOf(orderId)).toBe('PENDING');
    expect(await orders.expireAbandonedOrders(1)).toBe(1);
    expect(await statusOf(orderId)).toBe('CANCELLED');
  });
});
