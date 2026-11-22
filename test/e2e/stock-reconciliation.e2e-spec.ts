import { INestApplication } from '@nestjs/common';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal, stockOf } from '../helpers/db.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';

const USER_ID = 'seed_user';
const VARIANT_ID = 'seed_var2';

// P1-N.3: the nightly job checks every stock level against its ledger, reports what disagrees and corrects nothing.
describe('Nightly stock reconciliation (P1-N.3, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let task: StockReconciliationTask;
  let recorded: jest.SpyInstance;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    const metrics = app.get(AppMetrics);
    recorded = jest.spyOn(metrics, 'recordStockMismatches');
    task = new StockReconciliationTask(app.get(StockLedgerRepository), app.get(LoggerService), metrics);

    const address = await prisma.address.create({
      data: {
        userId: USER_ID,
        street: '1 Count St',
        city: 'Accra',
        recipientName: 'Buyer',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    const cart = await prisma.cart.create({ data: { userId: USER_ID } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: VARIANT_ID, quantity: 3 },
    });
    await placeOrderFromCart(app.get(OrdersService), USER_ID, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: address.id,
      contactEmail: 'user@example.com',
      contactPhone: '+233244000000',
    });
  });

  beforeEach(() => recorded.mockClear());
  afterAll(() => app.close());

  it('finds every level in line with its movements and active reservations after real stock activity', async () => {
    await expect(task.reconcile()).resolves.toEqual([]);
    expect(recorded).toHaveBeenCalledWith({
      ON_HAND: 0,
      RESERVED_MOVEMENTS: 0,
      ACTIVE_RESERVATIONS: 0,
      LOT_MOVEMENTS: 0,
      LOT_TOTAL: 0,
    });
  });

  it('flags a level changed outside the ledger, without correcting it', async () => {
    const before = await stockOf(prisma, VARIANT_ID);
    await prisma.$executeRaw`UPDATE "StockLevel" SET "onHand" = "onHand" + 2 WHERE "variantId" = ${VARIANT_ID}`;

    const mismatches = await task.reconcile();

    expect(mismatches).toEqual([
      expect.objectContaining({
        kind: 'ON_HAND',
        variantId: VARIANT_ID,
        expected: before.onHand,
        actual: before.onHand + 2,
      }),
    ]);
    expect(recorded).toHaveBeenCalledWith({
      ON_HAND: 1,
      RESERVED_MOVEMENTS: 0,
      ACTIVE_RESERVATIONS: 0,
      LOT_MOVEMENTS: 0,
      LOT_TOTAL: 0,
    });
    expect((await stockOf(prisma, VARIANT_ID)).onHand).toBe(before.onHand + 2);
    await prisma.$executeRaw`UPDATE "StockLevel" SET "onHand" = "onHand" - 2 WHERE "variantId" = ${VARIANT_ID}`;
  });

  it('flags a reservation that left ACTIVE without its stock being released', async () => {
    await prisma.stockReservation.updateMany({ where: { variantId: VARIANT_ID }, data: { status: 'RELEASED' } });

    const mismatches = await task.reconcile();

    expect(mismatches).toEqual([
      expect.objectContaining({ kind: 'ACTIVE_RESERVATIONS', variantId: VARIANT_ID, expected: 0, actual: 3 }),
    ]);
    await prisma.stockReservation.updateMany({ where: { variantId: VARIANT_ID }, data: { status: 'ACTIVE' } });
  });

  it('runs once when two workers start it together', async () => {
    const runs = await Promise.all([task.reconcile(), task.reconcile()]);

    expect(runs.filter((run) => run === null)).toHaveLength(1);
    expect(runs.find((run) => run !== null)).toEqual([]);
  });
});
