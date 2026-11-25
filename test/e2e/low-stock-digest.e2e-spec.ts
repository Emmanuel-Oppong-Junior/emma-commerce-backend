import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockLedgerService } from '../../src/inventory/stock-ledger.service';
import { LowStockAlertsService } from '../../src/inventory/low-stock/low-stock-alerts.service';
import { LowStockDigestTask } from '../../src/inventory/tasks/low-stock-digest.task';
import { NotificationSender } from '../../src/notifications/notification-sender';
import { EmailService } from '../../src/notifications/email/email.service';
import { LoggerService } from '../../src/commons/logger.service';
import { DomainEventJobData } from '../../src/outbox/domain-events';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal, setStock } from '../helpers/db.helper';

// P4-B.2 accept criteria on real Postgres: inventory.low_stock.v1 becomes one pending alert per variant and location,
// the digest lists the variants still low in one email per staff member holding inventory.alerts, drops recovered
// ones, and sends nothing when nothing is pending.
describe('Low-stock staff digest (P4-B.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: StockLedgerService;
  let sender: NotificationSender;
  let task: LowStockDigestTask;
  let sendEmail: jest.SpyInstance;
  let locationId: string;
  let seq = 0;

  const newVariant = async (onHand: number, lowStockThreshold: number | null = 5): Promise<string> => {
    seq += 1;
    const id = `low_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `low_prod_${seq}`,
        name: `Low item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `LOW-${seq}`, price: 10, basePrice: 10, lowStockThreshold } },
      },
    });
    await setStock(prisma, id, onHand);
    return id;
  };

  const staff = async (id: string, roleKey: string, isActive = true) => {
    const [store, role] = await Promise.all([
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.user.create({ data: { id, email: `${id}@example.com`, name: id, isActive } });
    await prisma.storeMembership.create({ data: { userId: id, storeId: store.id, roleId: role.id } });
  };

  /** Moves stock by `delta` through the ledger (which raises the event) and returns the low-stock events it recorded. */
  const adjust = async (variantId: string, delta: number) => {
    const eventsOf = () =>
      prisma.outboxEvent.findMany({ where: { type: 'inventory.low_stock.v1', aggregateId: variantId } });
    const seen = new Set((await eventsOf()).map((event) => event.id));
    await prisma.$transaction((tx) =>
      ledger.adjustAt(tx, variantId, locationId, delta, { adjustmentReason: delta < 0 ? 'LOST' : 'FOUND' }),
    );
    return (await eventsOf()).filter((event) => !seen.has(event.id));
  };

  /** What the notifications worker does with an outbox event: the job id is the event id. */
  const consume = (event: { id: string; type: string; aggregateId: string; payload: unknown }) =>
    sender.send(
      event.type,
      { eventId: event.id, aggregateId: event.aggregateId, payload: event.payload } as DomainEventJobData,
      event.id,
    );

  const alertsOf = (variantId: string) =>
    prisma.lowStockAlert.findMany({ where: { variantId }, orderBy: { createdAt: 'asc' } });
  const digestEvents = () =>
    prisma.outboxEvent.findMany({ where: { type: 'inventory.low_stock_digest.v1' }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    ledger = app.get(StockLedgerService);
    sender = app.get(NotificationSender);
    task = new LowStockDigestTask(app.get(LowStockAlertsService), app.get(LoggerService));
    sendEmail = jest.spyOn(app.get(EmailService), 'send').mockResolvedValue({ messageId: 'em-1' });
    await resetDb(prisma);
    await seedMinimal(prisma);
    await staff('alerts_clerk', 'INVENTORY_CLERK');
    await staff('alerts_cashier', 'CASHIER');
    await staff('alerts_former_clerk', 'INVENTORY_CLERK', false);
    locationId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
  });

  beforeEach(async () => {
    sendEmail.mockClear();
    await prisma.lowStockAlert.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  afterAll(() => app.close());

  it('turns a low-stock event into one pending alert, once per event and once per variant until sent', async () => {
    const variantId = await newVariant(10);

    const [event] = await adjust(variantId, -6);
    await consume(event);
    await consume(event);
    // Recovers and falls again before any digest: a second event, still one pending alert.
    await adjust(variantId, 5);
    const [second] = await adjust(variantId, -5);
    await consume(second);

    expect(await alertsOf(variantId)).toEqual([
      expect.objectContaining({ status: 'PENDING', availableAtAlert: 4, locationId, eventId: event.id }),
    ]);
  });

  it('sends one digest email job per active staff member holding inventory.alerts, listing variants still low', async () => {
    const low = await newVariant(10, 3);
    const recovered = await newVariant(10);
    for (const [variantId, delta] of [
      [low, -8],
      [recovered, -6],
    ] as const) {
      const [event] = await adjust(variantId, delta);
      await consume(event);
    }
    await adjust(recovered, 4);

    const run = await task.send();

    expect(run).toMatchObject({ listed: 1, dropped: 1, recipients: 3 });
    const events = await digestEvents();
    expect(events.map((e) => (e.payload as { recipientId: string }).recipientId).sort()).toEqual([
      'alerts_clerk',
      'seed_admin',
      'seed_super_admin',
    ]);
    expect(new Set(events.map((e) => e.aggregateId))).toEqual(new Set([run!.digestId]));
    expect(await alertsOf(low)).toEqual([
      expect.objectContaining({ status: 'SENT', digestId: run!.digestId, availableAtDigest: 2 }),
    ]);
    expect(await alertsOf(recovered)).toEqual([expect.objectContaining({ status: 'DROPPED', digestId: null })]);

    await consume(events[0]);
    const recipient = await prisma.user.findUniqueOrThrow({
      where: { id: (events[0].payload as { recipientId: string }).recipientId },
    });
    expect(sendEmail).toHaveBeenCalledWith(
      recipient.email,
      expect.objectContaining({
        subject: 'Low stock: 1 variant',
        html: expect.stringContaining('<tr><td>Low item 2</td><td>LOW-2</td><td>2</td></tr>') as unknown,
      }),
      events[0].id,
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when nothing is pending, and nothing twice', async () => {
    const variantId = await newVariant(10);
    const [event] = await adjust(variantId, -7);
    await consume(event);

    const runs = await Promise.all([task.send(), task.send()]);
    const again = await task.send();

    const sent = runs.filter((run) => run?.digestId);
    expect(sent).toHaveLength(1);
    expect(again).toEqual({ digestId: null, listed: 0, dropped: 0, recipients: 0 });
    expect(await digestEvents()).toHaveLength(3);
  });

  it('drops everything and emails nobody when every pending variant recovered', async () => {
    const variantId = await newVariant(10);
    const [event] = await adjust(variantId, -6);
    await consume(event);
    await adjust(variantId, 6);

    const run = await task.send();

    expect(run).toEqual({ digestId: null, listed: 0, dropped: 1, recipients: 0 });
    expect(await digestEvents()).toEqual([]);
  });
});
