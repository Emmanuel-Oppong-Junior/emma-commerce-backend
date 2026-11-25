import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AbandonedCartTask } from '../../src/cart/abandoned/abandoned-cart.task';
import { NotificationSender } from '../../src/notifications/notification-sender';
import { EmailService } from '../../src/notifications/email/email.service';
import { SmsSender } from '../../src/notifications/sms/sms-sender';
import { DomainEventJobData } from '../../src/outbox/domain-events';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, verifyPhoneForCod } from '../helpers/db.helper';
import { signInUser } from '../helpers/auth.helper';

const ADD = `mutation Add($variantId: ID!, $quantity: Int!) {
  addToCart(input: { variantId: $variantId, quantity: $quantity }) { items { id variantId quantity } }
}`;
const SAVE = `mutation Save($id: ID!) { saveCartItemForLater(cartItemId: $id) { items { id variantId quantity } } }`;
const SAVED = `{ savedItems { id variantId quantity available unavailableReason variant { id sku } } }`;
const MOVE = `mutation Move($id: ID!) { moveSavedItemToCart(savedItemId: $id) { items { variantId quantity } } }`;
const REMOVE = `mutation Remove($id: ID!) { removeSavedItem(savedItemId: $id) }`;
const UNSUBSCRIBE = `mutation Unsubscribe($token: String!) { unsubscribeMarketingEmail(token: $token) }`;

const HOUR = 60 * 60 * 1000;

describe('Saved for later and abandoned-cart reminders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let task: AbandonedCartTask;
  let sender: NotificationSender;
  let emails: jest.SpyInstance;
  let texts: jest.SpyInstance;

  const gql = async (query: string, variables: Record<string, unknown> = {}) =>
    (await gqlRequest(app, query, variables, userToken).expect(200)).body;
  const cartItems = async () =>
    prisma.cartItem.findMany({ where: { cart: { userId: 'seed_user' } }, orderBy: { createdAt: 'asc' } });
  /** Puts the user's cart lines back in time, as if left there `hours` ago. */
  const ageCart = (hours: number) =>
    prisma.cartItem.updateMany({
      where: { cart: { userId: 'seed_user' } },
      data: { updatedAt: new Date(Date.now() - hours * HOUR) },
    });
  const optIn = (channel: 'EMAIL' | 'SMS', enabled = true) =>
    prisma.notificationPreference.upsert({
      where: { userId_category_channel: { userId: 'seed_user', category: 'MARKETING', channel } },
      create: { userId: 'seed_user', category: 'MARKETING', channel, enabled },
      update: { enabled },
    });
  const reminderEvents = () =>
    prisma.outboxEvent.findMany({ where: { type: 'cart.abandoned_reminder.v1' }, orderBy: { createdAt: 'asc' } });
  /** What the notifications worker does with the reminder event. */
  const consume = (event: { id: string; aggregateId: string; payload: unknown }) =>
    sender.send(
      'cart.abandoned_reminder.v1',
      { eventId: event.id, aggregateId: event.aggregateId, payload: event.payload } as DomainEventJobData,
      event.id,
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    task = app.get(AbandonedCartTask);
    sender = app.get(NotificationSender);
    emails = jest.spyOn(app.get(EmailService), 'send').mockResolvedValue({ messageId: 'em-1' });
    texts = jest.spyOn(app.get(SmsSender), 'send').mockResolvedValue({ messageId: 'sms-1' });
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  beforeEach(async () => {
    emails.mockClear();
    texts.mockClear();
    await prisma.cartItem.deleteMany();
    await prisma.savedCartItem.deleteMany();
    await prisma.abandonedCartReminder.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.notificationPreference.deleteMany();
    await prisma.store.updateMany({ data: { abandonedCartReminderDelayHours: 4 } });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('saved for later', () => {
    it('moves a cart line to the saved list and back, adding quantities for a variant saved twice', async () => {
      const added = await gql(ADD, { variantId: 'seed_var1', quantity: 2 });
      const [line] = added.data.addToCart.items;

      const saved = await gql(SAVE, { id: line.id });
      expect(saved.errors).toBeUndefined();
      expect(saved.data.saveCartItemForLater.items).toEqual([]);

      const again = await gql(ADD, { variantId: 'seed_var1', quantity: 1 });
      await gql(SAVE, { id: again.data.addToCart.items[0].id });
      const list = (await gql(SAVED)).data.savedItems;
      expect(list).toEqual([
        {
          id: expect.any(String),
          variantId: 'seed_var1',
          quantity: 3,
          available: true,
          unavailableReason: null,
          variant: { id: 'seed_var1', sku: expect.any(String) },
        },
      ]);

      const moved = await gql(MOVE, { id: list[0].id });
      expect(moved.errors).toBeUndefined();
      expect(moved.data.moveSavedItemToCart.items).toEqual([{ variantId: 'seed_var1', quantity: 3 }]);
      expect((await gql(SAVED)).data.savedItems).toEqual([]);
    });

    it('shows a variant no longer on sale as unavailable and never moves it back', async () => {
      const saved = await prisma.savedCartItem.create({
        data: { userId: 'seed_user', variantId: 'seed_var_inactive', quantity: 1 },
      });

      const [item] = (await gql(SAVED)).data.savedItems;
      expect(item).toMatchObject({ available: false, unavailableReason: expect.stringContaining('not on sale') });

      const moved = await gql(MOVE, { id: saved.id });
      expect(moved.errors[0].extensions).toMatchObject({ code: 'BAD_REQUEST', reason: 'SAVED_ITEM_UNAVAILABLE' });
      expect(await cartItems()).toEqual([]);
      expect(await prisma.savedCartItem.count()).toBe(1);

      expect((await gql(REMOVE, { id: saved.id })).data.removeSavedItem).toBe(true);
      expect(await prisma.savedCartItem.count()).toBe(0);
    });

    it("cannot touch another customer's cart line or saved item", async () => {
      await prisma.user.create({ data: { id: 'saved_other', email: 'saved.other@test.local' } });
      const other = await prisma.cart.create({
        data: {
          userId: 'saved_other',
          items: { create: { productId: 'seed_prod1', variantId: 'seed_var1', quantity: 1 } },
        },
        include: { items: true },
      });
      const otherSaved = await prisma.savedCartItem.create({
        data: { userId: 'saved_other', variantId: 'seed_var2', quantity: 1 },
      });

      expect((await gql(SAVE, { id: other.items[0].id })).errors[0].extensions.code).toBe('NOT_FOUND');
      expect((await gql(MOVE, { id: otherSaved.id })).errors[0].extensions.code).toBe('NOT_FOUND');
      expect((await gql(REMOVE, { id: otherSaved.id })).errors[0].extensions.code).toBe('NOT_FOUND');
      expect(await prisma.savedCartItem.count({ where: { userId: 'saved_other' } })).toBe(1);
    });
  });

  describe('abandoned-cart reminders', () => {
    const leaveCart = async (hoursAgo: number) => {
      await gql(ADD, { variantId: 'seed_var1', quantity: 2 });
      await ageCart(hoursAgo);
    };

    it('reminds a consenting customer once per cart state, by email with the items, cart link and unsubscribe link', async () => {
      await optIn('EMAIL');
      await leaveCart(5);

      expect(await task.run()).toMatchObject({ reminded: 1 });
      expect(await task.run()).toMatchObject({ reminded: 0, skipped: { ALREADY_REMINDED: 1 } });

      const [event] = await reminderEvents();
      await consume(event);
      await consume(event);

      expect(emails).toHaveBeenCalledTimes(1);
      const [to, content, key] = emails.mock.calls[0] as [string, { subject: string; html: string }, string];
      expect([to, key]).toEqual(['user@example.com', event.id]);
      expect(content.subject).toBe('You left something in your cart');
      expect(content.html).toMatch(/<li>2 × [^<]+<\/li>/);
      expect(content.html).toContain('/cart"');
      expect(content.html).toMatch(/\/unsubscribe\?token=[A-Za-z0-9_.-]+/);
      // No SMS consent (and no verified phone): the SMS row is recorded as skipped, nothing is texted.
      expect(texts).not.toHaveBeenCalled();
      const rows = await prisma.notification.findMany({
        where: { templateKey: 'cart.abandoned' },
        select: { channel: true, category: true, status: true, errorCode: true },
        orderBy: { channel: 'asc' },
      });
      expect(rows).toEqual([
        { channel: 'EMAIL', category: 'MARKETING', status: 'SENT', errorCode: null },
        { channel: 'SMS', category: 'MARKETING', status: 'SKIPPED', errorCode: 'NO_CONSENT' },
      ]);
    });

    it('also texts a customer with SMS marketing consent and a verified phone', async () => {
      await verifyPhoneForCod(prisma);
      await optIn('SMS');
      await leaveCart(5);

      await task.run();
      await consume((await reminderEvents())[0]);

      expect(emails).not.toHaveBeenCalled();
      expect(texts).toHaveBeenCalledWith(
        '+233244000000',
        expect.stringMatching(/^Emma Commerce: you left 2 items in your cart\. Complete your order: http\S+\/cart /),
        'cart.abandoned',
      );
    });

    it('reminds nobody without consent, about a cart changed within the delay, or after an order since', async () => {
      await leaveCart(5);
      expect(await task.run()).toMatchObject({ reminded: 0 });

      await optIn('EMAIL');
      // Changed within the delay: not even a candidate yet.
      await ageCart(2);
      expect(await task.run()).toMatchObject({ reminded: 0 });

      await ageCart(5);
      await prisma.order.create({
        data: {
          orderNumber: 990001,
          userId: 'seed_user',
          grandTotal: 10,
          currency: 'GHS',
          pricingVersion: 0,
          contactEmail: 'user@example.com',
          contactPhone: '+233244000111',
        },
      });
      expect(await task.run()).toMatchObject({ reminded: 0, skipped: { ORDERED_SINCE: 1 } });
      expect(await reminderEvents()).toEqual([]);
      await prisma.order.deleteMany({ where: { orderNumber: 990001 } });
    });

    it('waits for the store delay setting and sends at most one reminder per customer a week', async () => {
      await optIn('EMAIL');
      await prisma.store.updateMany({ data: { abandonedCartReminderDelayHours: 8 } });
      await leaveCart(5);
      expect(await task.run()).toMatchObject({ reminded: 0 });
      await prisma.store.updateMany({ data: { abandonedCartReminderDelayHours: 4 } });

      expect(await task.run()).toMatchObject({ reminded: 1 });
      // The cart changes (a new state), but a reminder went out less than a week ago.
      await gql(ADD, { variantId: 'seed_var1', quantity: 1 });
      await ageCart(5);
      expect(await task.run()).toMatchObject({ reminded: 0, skipped: { REMINDED_RECENTLY: 1 } });
    });

    it('skips the email when consent was withdrawn after the reminder was recorded', async () => {
      await optIn('EMAIL');
      await leaveCart(5);
      await task.run();
      await optIn('EMAIL', false);

      await consume((await reminderEvents())[0]);

      expect(emails).not.toHaveBeenCalled();
      expect(
        await prisma.notification.findFirst({ where: { templateKey: 'cart.abandoned', channel: 'EMAIL' } }),
      ).toMatchObject({ status: 'SKIPPED', errorCode: 'NO_CONSENT' });
    });

    it('withdraws email marketing consent from the unsubscribe link, in the ledger as EMAIL_LINK', async () => {
      await prisma.notificationPreference.deleteMany();
      await gqlRequest(
        app,
        `mutation { updateNotificationPreference(input: { category: MARKETING, channel: EMAIL, enabled: true }) { enabled } }`,
        {},
        userToken,
      ).expect(200);
      await leaveCart(5);
      await task.run();
      await consume((await reminderEvents())[0]);
      const html = (emails.mock.calls[0] as [string, { html: string }])[1].html;
      const token = decodeURIComponent(/unsubscribe\?token=([^"]+)"/.exec(html)![1]);

      const res = await gqlRequest(app, UNSUBSCRIBE, { token }).expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.unsubscribeMarketingEmail).toBe(true);
      expect(
        (await gqlRequest(app, UNSUBSCRIBE, { token: `${token}x` }).expect(200)).body.errors[0].extensions.reason,
      ).toBe('INVALID_UNSUBSCRIBE_TOKEN');

      const preference = await prisma.notificationPreference.findUniqueOrThrow({
        where: { userId_category_channel: { userId: 'seed_user', category: 'MARKETING', channel: 'EMAIL' } },
      });
      expect(preference.enabled).toBe(false);
      const ledger = await prisma.consentEvent.findMany({
        where: { userId: 'seed_user', channel: 'EMAIL' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(ledger.slice(-2).map((e) => [e.action, e.source])).toEqual([
        ['GRANTED', 'ACCOUNT_SETTINGS'],
        ['WITHDRAWN', 'EMAIL_LINK'],
      ]);
    });
  });
});
