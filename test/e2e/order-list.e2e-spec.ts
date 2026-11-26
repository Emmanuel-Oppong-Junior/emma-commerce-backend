import { INestApplication } from '@nestjs/common';
import { OrderStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

// The staff order list is read a page at a time (P9-L: unbounded, it failed with Prisma P2029 at 20,000 orders).
describe('Staff order list pages (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let staffToken: string;
  const ORDER_COUNT = 25;
  // Order i was placed i minutes after the first, so the newest is order_24; every third one was cancelled.
  const orderId = (i: number) => `list_order_${String(i).padStart(2, '0')}`;
  const statusOf = (i: number) => (i % 3 === 0 ? OrderStatus.CANCELLED : OrderStatus.CONFIRMED);
  const newestFirst = Array.from({ length: ORDER_COUNT }, (_, i) => orderId(ORDER_COUNT - 1 - i));

  const orders = async (args = '') => {
    const res = await gqlRequest(app, `{ orders${args} { id status } }`, undefined, staffToken).expect(200);
    return res.body as {
      data?: { orders: { id: string; status: string }[] };
      errors?: { extensions: { code: string } }[];
    };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    staffToken = await signInAdmin(app);
    const first = Date.now() - 60 * 60_000;
    for (let i = 0; i < ORDER_COUNT; i++) {
      await prisma.order.create({
        data: {
          id: orderId(i),
          orderNumber: await takeOrderNumber(prisma),
          userId: 'seed_user',
          currency: 'GHS',
          pricingVersion: 0,
          grandTotal: 10,
          status: statusOf(i),
          contactEmail: 'user@example.com',
          contactPhone: '+233244000000',
          createdAt: new Date(first + i * 60_000),
        },
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives 20 orders, newest first, by default', async () => {
    const body = await orders();

    expect(body.errors).toBeUndefined();
    expect(body.data!.orders.map((order) => order.id)).toEqual(newestFirst.slice(0, 20));
  });

  it('continues after the last order of the previous page until a short page', async () => {
    const page1 = await orders('(first: 10)');
    const page2 = await orders(`(first: 10, after: "${page1.data!.orders[9].id}")`);
    const page3 = await orders(`(first: 10, after: "${page2.data!.orders[9].id}")`);

    expect([...page1.data!.orders, ...page2.data!.orders, ...page3.data!.orders].map((order) => order.id)).toEqual(
      newestFirst,
    );
    expect(page3.data!.orders).toHaveLength(5);
  });

  it('filters by status', async () => {
    const body = await orders('(first: 100, status: CANCELLED)');

    expect(body.data!.orders.map((order) => order.id)).toEqual(
      newestFirst.filter((id) => statusOf(Number(id.slice(-2))) === OrderStatus.CANCELLED),
    );
  });

  it.each([0, 101])('refuses a page size of %i', async (first) => {
    const body = await orders(`(first: ${first})`);

    expect(body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});
