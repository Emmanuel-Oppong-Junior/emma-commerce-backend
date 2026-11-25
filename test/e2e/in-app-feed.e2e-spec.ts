import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { NotificationSender } from '../../src/notifications/notification-sender';
import { EmailService } from '../../src/notifications/email/email.service';
import { NotificationRetentionTask } from '../../src/notifications/notification-retention.task';
import { LoggerService } from '../../src/commons/logger.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

const FEED = `query Feed($first: Int, $after: ID, $unreadOnly: Boolean) {
  myNotifications(first: $first, after: $after, unreadOnly: $unreadOnly) {
    totalCount hasNextPage nodes { id title body templateKey refType refId readAt }
  }
}`;
const UNREAD = `{ unreadNotificationCount }`;
const MARK = `mutation Mark($ids: [ID!]!) { markNotificationsRead(ids: $ids) }`;
const MARK_ALL = `mutation { markAllNotificationsRead }`;

type FeedNode = { id: string; title: string; body: string; templateKey: string; refType: string; refId: string };

describe('In-app notification feed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sender: NotificationSender;
  let userToken: string;
  let adminToken: string;
  let orderId: string;
  let orderNumber: number;
  let eventCount = 0;

  const feed = async (variables: Record<string, unknown> = {}, token = userToken) => {
    const res = await gqlRequest(app, FEED, variables, token).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.myNotifications as { totalCount: number; hasNextPage: boolean; nodes: FeedNode[] };
  };
  const unread = async (token = userToken) =>
    (await gqlRequest(app, UNREAD, {}, token).expect(200)).body.data.unreadNotificationCount as number;

  /** What the notifications worker does with an outbox event: the job id is the event id. */
  const consume = (type: string, payload: object) => {
    eventCount += 1;
    const eventId = `feed-evt-${eventCount}`;
    return sender.send(type, { eventId, aggregateId: orderId, payload }, eventId).then(() => eventId);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    sender = app.get(NotificationSender);
    jest.spyOn(app.get(EmailService), 'send').mockResolvedValue({ messageId: 'em-1' });
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
    orderNumber = await takeOrderNumber(prisma);
    orderId = (
      await prisma.order.create({
        data: {
          orderNumber,
          userId: 'seed_user',
          status: 'CONFIRMED',
          grandTotal: 120,
          currency: 'GHS',
          pricingVersion: 0,
          contactEmail: 'user@example.com',
          contactPhone: '+233244000111',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('adds order events to the customer feed once, newest first, linked to the order', async () => {
    await consume('order.placed.v1', { orderId });
    const paid = await consume('payment.succeeded.v1', { orderId, paymentId: 'pay1', amount: '120.00' });
    // The payment event's job running again adds nothing more.
    await sender.send(
      'payment.succeeded.v1',
      { eventId: paid, aggregateId: orderId, payload: { orderId, paymentId: 'pay1', amount: '120.00' } },
      paid,
    );
    await consume('order.status_changed.v2', { orderId, from: 'IN_FULFILMENT', to: 'COMPLETED' });

    const { nodes, totalCount } = await feed();

    expect(totalCount).toBe(2);
    expect(nodes.map((n) => [n.templateKey, n.title, n.body])).toEqual([
      ['payment.received', 'Payment received', `We received your payment of GHS 120.00 for order #${orderNumber}.`],
      ['order.placed', 'Order placed', `Your order #${orderNumber} (GHS 120.00) has been placed.`],
    ]);
    expect(nodes.every((n) => n.refType === 'Order' && n.refId === orderId)).toBe(true);
    expect(await unread()).toBe(2);
  });

  it('pages with a cursor and filters unread', async () => {
    const first = await feed({ first: 1 });
    expect(first).toMatchObject({ totalCount: 2, hasNextPage: true });
    const second = await feed({ first: 1, after: first.nodes[0].id });
    expect(second.hasNextPage).toBe(false);
    expect(second.nodes[0].templateKey).toBe('order.placed');

    const unknown = await gqlRequest(app, FEED, { after: 'not-a-notification' }, userToken).expect(200);
    expect(unknown.body.errors[0].extensions.code).toBe('BAD_REQUEST');
  });

  it("marks only the caller's notifications read", async () => {
    const { nodes } = await feed();
    const others = await gqlRequest(app, MARK, { ids: nodes.map((n) => n.id) }, adminToken).expect(200);
    expect(others.body.data.markNotificationsRead).toBe(0);
    expect((await feed({}, adminToken)).totalCount).toBe(0);

    const mine = await gqlRequest(app, MARK, { ids: [nodes[0].id] }, userToken).expect(200);
    expect(mine.body.data.markNotificationsRead).toBe(1);
    expect(await unread()).toBe(1);
    expect((await feed({ unreadOnly: true })).nodes.map((n) => n.id)).toEqual([nodes[1].id]);

    const all = await gqlRequest(app, MARK_ALL, {}, userToken).expect(200);
    expect(all.body.data.markAllNotificationsRead).toBe(1);
    expect(await unread()).toBe(0);
  });

  it('needs a signed-in user', async () => {
    const res = await gqlRequest(app, UNREAD, {}).expect(200);
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('purges in-app notifications after 90 days and delivery records after 180', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const old = (days: number) => new Date(now.getTime() - days * day);
    const row = (dedupeKey: string, channel: 'IN_APP' | 'EMAIL', createdAt: Date) => ({
      dedupeKey,
      userId: 'seed_user',
      templateKey: 'order.placed',
      templateVersion: 2,
      category: 'TRANSACTIONAL' as const,
      channel,
      createdAt,
    });
    await prisma.notification.createMany({
      data: [
        row('purge-inapp-old', 'IN_APP', old(91)),
        row('purge-inapp-recent', 'IN_APP', old(89)),
        row('purge-email-old', 'EMAIL', old(181)),
        row('purge-email-kept', 'EMAIL', old(100)),
      ],
    });

    const task = new NotificationRetentionTask(prisma, app.get(LoggerService));
    await expect(task.purge(now)).resolves.toEqual({ inApp: 1, deliveryRecords: 1 });

    const left = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: 'purge-' } } });
    expect(left.map((n) => n.dedupeKey).sort()).toEqual(['purge-email-kept', 'purge-inapp-recent']);
  });
});
