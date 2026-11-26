import { INestApplication } from '@nestjs/common';
import { DeliveryServiceLevel, FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { weekdayOf } from '../../src/shipping-zones/slots/delivery-slots';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { ANY_QUOTE_HASH } from '../helpers/checkout.helper';

const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };
const DAY_MS = 24 * 60 * 60 * 1000;
const dateIn = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

// P5-A.2: STANDARD delivery to a zone with slots books one; capacity is never oversold; cancel and expiry release it.
// Times are Africa/Accra (= UTC). Fixtures on the seeded Accra zone: tomorrow 09:00-12:00 (capacity 1) and 13:00-17:00
// (capacity 5).
describe('Delivery slots (P5-A.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let adminToken: string;
  let morning: string;
  let afternoon: string;
  let shopperCount = 0;
  const tomorrow = dateIn(1);

  const adminGql = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, adminToken).expect(200);

  const newShopper = async () => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `slots-${shopperCount}@example.com` } });
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
    });
    const address = await prisma.address.create({
      data: {
        userId: user.id,
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Slot St',
        city: 'Accra',
        country: 'GH',
      },
    });
    const params = (slotId?: string, serviceLevel?: DeliveryServiceLevel) => ({
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: address.id,
      ...(slotId && { deliverySlot: { slotId, date: tomorrow } }),
      ...(serviceLevel && { serviceLevel }),
    });
    const place = async (slotId?: string) => {
      const quote = await orders.checkoutQuote(user.id, params(slotId));
      return orders.createOrderFromCart(user.id, { ...params(slotId), ...contact, quoteHash: quote.quoteHash });
    };
    return { userId: user.id, params, place };
  };

  const reasonOf = (error: unknown) =>
    (error as { getResponse(): { extensions?: { reason?: string } } }).getResponse().extensions?.reason;
  const bookedIn = async (slotId: string) =>
    (await prisma.deliverySlotBooking.findFirst({ where: { slotId } }))?.booked ?? 0;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    const weekday = weekdayOf(tomorrow);
    const create = async (start: string, end: string, capacity: number) => {
      const res = await adminGql(
        `mutation { createDeliverySlot(zoneId: "seed_zone_accra", input: {
          weekday: ${weekday}, startTime: "${start}", endTime: "${end}", capacity: ${capacity} }) { id startTime } }`,
      );
      expect(res.body.errors).toBeUndefined();
      return res.body.data.createDeliverySlot.id as string;
    };
    morning = await create('09:00', '12:00', 1);
    afternoon = await create('13:00', '17:00', 5);
    await prisma.rateRule.create({
      data: { zoneId: 'seed_zone_accra', serviceLevel: 'EXPRESS', baseFee: 40 },
    });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('lists the slots for STANDARD delivery and requires one at placement', async () => {
    const shopper = await newShopper();

    const quote = await orders.checkoutQuote(shopper.userId, shopper.params());
    const placed = await orders
      .createOrderFromCart(shopper.userId, { ...shopper.params(), ...contact, quoteHash: quote.quoteHash })
      .catch((e: unknown) => e);

    expect(quote.deliverySlotRequired).toBe(true);
    expect(quote.deliverySlots.filter((slot) => slot.date === tomorrow).map((slot) => slot.slotId)).toEqual([
      morning,
      afternoon,
    ]);
    expect(reasonOf(placed)).toBe('DELIVERY_SLOT_REQUIRED');
  });

  it('books the slot on the order, snapshotting the date and window; the quote hash covers the slot', async () => {
    const shopper = await newShopper();
    const before = await bookedIn(afternoon);

    const other = await orders.checkoutQuote(shopper.userId, shopper.params(morning));
    const chosen = await orders.checkoutQuote(shopper.userId, shopper.params(afternoon));
    const order = await shopper.place(afternoon);

    expect(other.delivery!.slot).toMatchObject({ slotId: morning });
    expect(chosen.quoteHash).not.toBe(other.quoteHash);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored).toMatchObject({ deliverySlotId: afternoon, deliveryWindowStart: 780, deliveryWindowEnd: 1020 });
    expect(stored.deliveryDate?.toISOString().slice(0, 10)).toBe(tomorrow);
    expect(await bookedIn(afternoon)).toBe(before + 1);
    const res = await adminGql(`{ viewOrder(id: "${order.id}") { deliverySlot { slotId date startTime endTime } } }`);
    expect(res.body.data.viewOrder.deliverySlot).toEqual({
      slotId: afternoon,
      date: tomorrow,
      startTime: '13:00',
      endTime: '17:00',
    });
  });

  it('shows the windows of the listed and chosen slots in the GraphQL quote', async () => {
    const cart = await prisma.cart.upsert({
      where: { userId: 'seed_user' },
      create: { userId: 'seed_user' },
      update: {},
    });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
    });
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Kofi Mensah',
        phone: '+233244000001',
        street: '2 Slot St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });

    const res = await gqlRequest(
      app,
      `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) {
        deliverySlots { slotId date startTime endTime remaining }
        delivery { slot { slotId startTime endTime remaining } } } }`,
      {
        input: {
          fulfillmentType: 'DELIVERY',
          shippingAddressId: address.id,
          deliverySlot: { slotId: afternoon, date: tomorrow },
        },
      },
      await signInUser(app),
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    const quote = res.body.data.checkoutQuote;
    expect(quote.deliverySlots).toContainEqual(
      expect.objectContaining({ slotId: morning, date: tomorrow, startTime: '09:00', endTime: '12:00' }),
    );
    expect(quote.delivery.slot).toMatchObject({ slotId: afternoon, startTime: '13:00', endTime: '17:00' });
  });

  it('gives the last place to one of two simultaneous orders; the other gets SLOT_FULL and nothing is placed', async () => {
    const first = await newShopper();
    const second = await newShopper();
    const quotes = await Promise.all(
      [first, second].map((shopper) => orders.checkoutQuote(shopper.userId, shopper.params(morning))),
    );

    const results = await Promise.allSettled(
      [first, second].map((shopper, i) =>
        orders.createOrderFromCart(shopper.userId, {
          ...shopper.params(morning),
          ...contact,
          quoteHash: quotes[i].quoteHash,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(reasonOf(refused.reason)).toBe('SLOT_FULL');
    expect(await bookedIn(morning)).toBe(1);
    expect(await prisma.order.count({ where: { deliverySlotId: morning } })).toBe(1);
  });

  it('releases the place once when the order is cancelled, and when an unpaid order expires', async () => {
    const cancelled = await newShopper();
    const order = await cancelled.place(afternoon);
    const booked = await bookedIn(afternoon);

    await orders.cancelOrder(cancelled.userId, order.id);
    await expect(orders.cancelOrder(cancelled.userId, order.id)).rejects.toThrow();

    expect(await bookedIn(afternoon)).toBe(booked - 1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deliverySlotReleasedAt).not.toBeNull();

    const abandoned = await newShopper();
    const unpaid = await abandoned.place(afternoon);
    await prisma.order.update({
      where: { id: unpaid.id },
      data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });

    await orders.expireAbandonedOrders(1);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: unpaid.id } })).status).toBe('EXPIRED');
    expect(await bookedIn(afternoon)).toBe(booked - 1);
  });

  it('does not offer a closed date or a slot past its cutoff', async () => {
    const shopper = await newShopper();
    await prisma.deliverySlot.update({ where: { id: afternoon }, data: { cutoffHours: 48 } });
    const res = await adminGql(
      `mutation { addDeliveryClosure(zoneId: "seed_zone_accra", input: { date: "${dateIn(8)}", reason: "Holiday" }) { id date } }`,
    );

    const quote = await orders.checkoutQuote(shopper.userId, shopper.params());
    const late = await orders.checkoutQuote(shopper.userId, shopper.params(afternoon)).catch((e: unknown) => e);
    await prisma.deliverySlot.update({ where: { id: afternoon }, data: { cutoffHours: 0 } });

    expect(res.body.data.addDeliveryClosure.date).toBe(dateIn(8));
    expect(quote.deliverySlots.some((slot) => slot.slotId === afternoon && slot.date === tomorrow)).toBe(false);
    expect(reasonOf(late)).toBe('DELIVERY_SLOT_UNAVAILABLE');

    await prisma.deliveryClosure.create({
      data: { zoneId: 'seed_zone_accra', date: new Date(`${tomorrow}T00:00:00Z`) },
    });
    const closed = await orders.checkoutQuote(shopper.userId, shopper.params());
    await prisma.deliveryClosure.deleteMany({ where: { date: new Date(`${tomorrow}T00:00:00Z`) } });
    expect(closed.deliverySlots.some((slot) => slot.date === tomorrow)).toBe(false);
  });

  it('keeps EXPRESS and pickup free of slots', async () => {
    const shopper = await newShopper();

    const express = await orders.checkoutQuote(shopper.userId, shopper.params(undefined, 'EXPRESS'));
    const expressWithSlot = await orders
      .checkoutQuote(shopper.userId, shopper.params(afternoon, 'EXPRESS'))
      .catch((e: unknown) => e);
    const placedExpress = await orders
      .createOrderFromCart(shopper.userId, {
        ...shopper.params(undefined, 'EXPRESS'),
        ...contact,
        quoteHash: ANY_QUOTE_HASH,
      })
      .catch((e: unknown) => e);

    expect(express).toMatchObject({ deliverySlots: [], deliverySlotRequired: false });
    expect(reasonOf(expressWithSlot)).toBe('DELIVERY_SLOT_UNAVAILABLE');
    // EXPRESS needs no slot: placement gets as far as comparing the quote hash.
    expect(reasonOf(placedExpress)).toBe('QUOTE_CHANGED');
  });

  it('lists the bookings of a date for staff only', async () => {
    const res = await adminGql(
      `{ deliveryBookings(date: "${tomorrow}") { slotId startTime capacity booked orders { orderNumber status } } }`,
    );
    const customer = await gqlRequest(
      app,
      `{ deliveryBookings(date: "${tomorrow}") { slotId } }`,
      undefined,
      await signInUser(app),
    ).expect(200);

    const morningBooking = (
      res.body.data.deliveryBookings as { slotId: string; booked: number; orders: unknown[] }[]
    ).find((booking) => booking.slotId === morning);
    expect(morningBooking).toMatchObject({ booked: 1, orders: [expect.objectContaining({ status: 'PLACED' })] });
    expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(await prisma.auditLog.count({ where: { entity: 'DeliverySlot', action: 'CREATE' } })).toBe(2);
  });
});
