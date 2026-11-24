import { Prisma } from '../generated/prisma/client';
import { NotificationSender, passwordResetUrl } from './notification-sender';

const ORDER = {
  id: 'order1',
  orderNumber: 10042,
  userId: 'user1',
  currency: 'GHS',
  grandTotal: new Prisma.Decimal('250.5'),
  shippingTotal: new Prisma.Decimal('15'),
  discountTotal: new Prisma.Decimal('0'),
  paymentMethod: 'ONLINE',
  user: { email: 'kwame@gmail.com' },
  items: [{ productName: 'Kente scarf', quantity: 2, lineTotal: new Prisma.Decimal('235.5') }],
};

const REFUND = {
  amount: new Prisma.Decimal('128.5'),
  currency: 'GHS',
  reason: 'DAMAGED',
  shippingAmount: new Prisma.Decimal('20'),
  lines: [{ quantity: 2, orderItem: { productName: 'Kente scarf' } }],
};

const SECTION = {
  locationName: 'Main store',
  items: [{ locationName: 'Main store', productName: 'Kente scarf', sku: 'KS-1', available: 2, threshold: 5 }],
};

const SHIPMENT = {
  carrier: 'DHL',
  trackingNumber: 'TRK1',
  order: {
    orderNumber: 1042,
    userId: 'user1',
    contactPhone: '0243333333',
    shippingAddressSnapshot: { phone: '0242222222' },
    user: { phoneNumber: null, phoneVerifiedAt: null, phoneVerifiedNumber: null },
  },
};

const CONFIG: Record<string, unknown> = { FRONTEND_URL: 'https://shop.example.com/', JWT_RESET_TOKEN_TTL: 900 };

function buildSender(order: typeof ORDER | null = ORDER, refund: typeof REFUND | null = REFUND) {
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    shipment: { findUnique: jest.fn().mockResolvedValue(SHIPMENT) },
    refund: { findUnique: jest.fn().mockResolvedValue(refund) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'staff1', email: 'ama@store.example', isActive: true }),
      findFirst: jest.fn().mockResolvedValue({ id: 'user1' }),
    },
  };
  const dispatcher = { deliver: jest.fn().mockResolvedValue('SENT') };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const lowStockAlerts = {
    recordPending: jest.fn().mockResolvedValue(true),
    digestSections: jest.fn().mockResolvedValue([SECTION]),
  };
  const notifications = { queueShipmentSms: jest.fn().mockResolvedValue(undefined) };
  const readyForPickup = { notify: jest.fn().mockResolvedValue(undefined) };
  const deliveryCodes = { issue: jest.fn().mockResolvedValue('123456') };
  const config = { getOrThrow: (key: string) => CONFIG[key] };
  return {
    lowStockAlerts,
    notifications,
    readyForPickup,
    deliveryCodes,
    sender: new NotificationSender(
      prisma as never,
      dispatcher as never,
      logger as never,
      lowStockAlerts as never,
      notifications as never,
      readyForPickup as never,
      deliveryCodes as never,
      config as never,
    ),
    prisma,
    dispatcher,
    logger,
  };
}

const event = (payload: object) => ({ eventId: 'evt1', aggregateId: 'order1', payload });

/** The order's customer is emailed under the job id: the row key and the provider idempotency key. */
const orderEmail = (template: string, data: object, jobId = 'evt1') => ({
  dedupeKey: `${jobId}:EMAIL`,
  userId: 'user1',
  template,
  data,
  channel: 'EMAIL',
  to: 'kwame@gmail.com',
  idempotencyKey: jobId,
});

const smsTo = (to: string | null, template: string, data: object, jobId = 'evt1-sms') => ({
  dedupeKey: `${jobId}:SMS`,
  userId: 'user1',
  channel: 'SMS',
  to,
  template,
  data,
});

describe('NotificationSender', () => {
  it('emails the order receipt for order.placed.v1 by order number, with lines and totals read when sending', async () => {
    const { sender, prisma, dispatcher } = buildSender();

    await sender.send('order.placed.v1', event({ orderId: 'order1' }), 'evt1');

    expect(prisma.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order1' } }));
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('order.placed', {
        orderNumber: 10042,
        currency: 'GHS',
        lines: [{ productName: 'Kente scarf', quantity: 2, lineTotal: '235.50' }],
        shippingTotal: '15.00',
        discountTotal: '0.00',
        grandTotal: '250.50',
        cashOnDelivery: false,
      }),
    );
  });

  it('emails the legacy order.status_changed.v1 update with its status and tracking number', async () => {
    const { sender, dispatcher } = buildSender();

    await sender.send(
      'order.status_changed.v1',
      event({ orderId: 'order1', status: 'SHIPPED', trackingNumber: 'TRK1' }),
      'evt1',
    );
    await sender.send(
      'order.status_changed.v1',
      event({ orderId: 'order1', status: 'DELIVERED', trackingNumber: null }),
      'evt2',
    );

    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('order.updated', { orderNumber: 10042, status: 'SHIPPED', trackingNumber: 'TRK1' }),
    );
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('order.updated', { orderNumber: 10042, status: 'DELIVERED', trackingNumber: null }, 'evt2'),
    );
  });

  it.each(['order.shipment_updated.v1', 'shipment.tracking_updated.v1'])(
    'emails the shipped notice with its tracking number for %s',
    async (name) => {
      const { sender, dispatcher } = buildSender();

      await sender.send(name, event({ orderId: 'order1', shipmentId: 'ship1', trackingNumber: 'TRK9' }), 'evt1');

      expect(dispatcher.deliver).toHaveBeenCalledWith(
        orderEmail('shipment.dispatched', { orderNumber: 10042, trackingNumber: 'TRK9' }),
      );
    },
  );

  it('emails a completed order for order.status_changed.v2 and nobody for other statuses', async () => {
    const { sender, dispatcher, prisma } = buildSender();

    await sender.send(
      'order.status_changed.v2',
      event({ orderId: 'order1', from: 'IN_FULFILMENT', to: 'COMPLETED' }),
      'evt1',
    );
    await sender.send('order.status_changed.v2', event({ orderId: 'order1', from: 'PLACED', to: 'CANCELLED' }), 'evt2');

    expect(dispatcher.deliver).toHaveBeenCalledTimes(1);
    expect(dispatcher.deliver).toHaveBeenCalledWith(orderEmail('order.completed', { orderNumber: 10042 }));
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it('emails the dispatch for shipment.status_changed.v1 (OUT_FOR_DELIVERY) with its carrier and tracking number', async () => {
    const { sender, dispatcher } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({
        orderId: 'order1',
        shipmentId: 'ship1',
        status: 'OUT_FOR_DELIVERY',
        trackingNumber: 'TRK1',
        carrier: 'DHL',
      }),
      'evt1',
    );

    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('shipment.out_for_delivery', {
        orderNumber: 10042,
        carrier: 'DHL',
        trackingNumber: 'TRK1',
        deliveryCode: null,
      }),
    );
  });

  it('hands READY_FOR_PICKUP to the pickup notice (email and SMS) instead of the dispatch email', async () => {
    const { sender, dispatcher, readyForPickup } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status: 'READY_FOR_PICKUP', trackingNumber: null }),
      'evt1',
    );

    expect(readyForPickup.notify).toHaveBeenCalledWith('order1', 'evt1');
    expect(dispatcher.deliver).not.toHaveBeenCalled();
  });

  it('texts the ready-for-pickup SMS to the order customer from the job (the notice carries the place and hours)', async () => {
    const { sender, dispatcher } = buildSender();
    const notice = {
      orderNumber: 10023,
      pickupName: 'Osu Store',
      address: '12 Oxford St, Accra',
      hours: 'Mon-Fri 08:00-17:00, Sat-Sun closed',
      contactPhone: null,
      instructions: null,
    };

    await sender.send('sms.ready_for_pickup.v1', { to: '+233244123456', notice, userId: 'user1' }, 'evt1-sms');

    expect(dispatcher.deliver).toHaveBeenCalledWith(smsTo('+233244123456', 'shipment.ready_for_pickup', notice));
  });

  it('emails nobody for a shipment step that is not a dispatch', async () => {
    const { sender, dispatcher } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status: 'FAILED_DELIVERY', trackingNumber: null }),
      'evt1',
    );

    expect(dispatcher.deliver).not.toHaveBeenCalled();
  });

  it.each(['OUT_FOR_DELIVERY', 'DELIVERED'])(
    'queues the milestone SMS for shipment.status_changed.v1 (%s) under a job id derived from the event',
    async (status) => {
      const { sender, notifications, dispatcher } = buildSender();

      await sender.send(
        'shipment.status_changed.v1',
        event({ orderId: 'order1', shipmentId: 'ship1', status, trackingNumber: 'TRK1' }),
        'evt1',
      );

      expect(notifications.queueShipmentSms).toHaveBeenCalledWith(
        { orderId: 'order1', shipmentId: 'ship1', status },
        'evt1-sms',
      );
      for (const [delivery] of dispatcher.deliver.mock.calls as [{ channel: string }][]) {
        expect(delivery.channel).not.toBe('SMS');
      }
    },
  );

  it.each(['READY_FOR_PICKUP', 'FAILED_DELIVERY'])('queues no SMS for %s', async (status) => {
    const { sender, notifications } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status, trackingNumber: null }),
      'evt1',
    );

    expect(notifications.queueShipmentSms).not.toHaveBeenCalled();
  });

  it('texts the shipment milestone to the delivery address phone, reading the shipment when sending', async () => {
    const { sender, dispatcher, prisma } = buildSender();

    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'OUT_FOR_DELIVERY' },
      'evt1-sms',
    );

    expect(prisma.shipment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ship1' } }));
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      smsTo('+233242222222', 'shipment.out_for_delivery', {
        orderNumber: 1042,
        carrier: 'DHL',
        trackingNumber: 'TRK1',
        deliveryCode: null,
      }),
    );
  });

  it('adds the delivery code to the out-for-delivery SMS of a rider’s shipment still out (one text)', async () => {
    const { sender, dispatcher, prisma, deliveryCodes } = buildSender();
    const dispatchedAt = new Date('2026-11-23T09:00:00Z');
    prisma.shipment.findUnique.mockResolvedValue({
      ...SHIPMENT,
      status: 'OUT_FOR_DELIVERY',
      riderId: 'rider1',
      dispatchedAt,
    });

    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'OUT_FOR_DELIVERY' },
      'evt1-sms',
    );

    expect(deliveryCodes.issue).toHaveBeenCalledWith('ship1', dispatchedAt);
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1);
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      smsTo('+233242222222', 'shipment.out_for_delivery', {
        orderNumber: 1042,
        carrier: 'DHL',
        trackingNumber: 'TRK1',
        deliveryCode: '123456',
      }),
    );
  });

  it('issues no code for a shipment without a rider or no longer out for delivery', async () => {
    const { sender, prisma, deliveryCodes } = buildSender();
    const dispatchedAt = new Date();
    prisma.shipment.findUnique.mockResolvedValueOnce({
      ...SHIPMENT,
      status: 'OUT_FOR_DELIVERY',
      riderId: null,
      dispatchedAt,
    });
    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'OUT_FOR_DELIVERY' },
      'a',
    );
    prisma.shipment.findUnique.mockResolvedValueOnce({
      ...SHIPMENT,
      status: 'DELIVERED',
      riderId: 'rider1',
      dispatchedAt,
    });
    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'OUT_FOR_DELIVERY' },
      'b',
    );

    expect(deliveryCodes.issue).not.toHaveBeenCalled();
  });

  it('texts the verified account phone first', async () => {
    const { sender, dispatcher, prisma } = buildSender();
    const verified = {
      phoneNumber: '+233201111111',
      phoneVerifiedAt: new Date(),
      phoneVerifiedNumber: '+233201111111',
    };
    prisma.shipment.findUnique.mockResolvedValue({ ...SHIPMENT, order: { ...SHIPMENT.order, user: verified } });

    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'DELIVERED' },
      'j',
    );

    expect(dispatcher.deliver).toHaveBeenCalledWith(
      smsTo('+233201111111', 'shipment.delivered', { orderNumber: 1042 }, 'j'),
    );
  });

  it('sends no milestone SMS, with a warning naming ids only, when the shipment is gone or no phone is usable', async () => {
    const { sender, dispatcher, prisma, logger } = buildSender();
    prisma.shipment.findUnique.mockResolvedValueOnce(null);
    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'DELIVERED' },
      'j',
    );
    prisma.shipment.findUnique.mockResolvedValueOnce({
      ...SHIPMENT,
      order: { ...SHIPMENT.order, contactPhone: '+15550100', shippingAddressSnapshot: null },
    });
    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'DELIVERED' },
      'k',
    );

    // No phone: the row is recorded as skipped (NO_ADDRESS) by the dispatcher; nothing is sent.
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1);
    expect(dispatcher.deliver).toHaveBeenCalledWith(smsTo(null, 'shipment.delivered', { orderNumber: 1042 }, 'k'));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [message] of logger.warn.mock.calls as [string][]) expect(message).not.toContain('5550100');
  });

  it('emails the payment confirmation for payment.succeeded.v1 with the settled amount in the order currency', async () => {
    const { sender, dispatcher } = buildSender();

    await sender.send(
      'payment.succeeded.v1',
      event({ orderId: 'order1', paymentId: 'pay1', amount: '250.50' }),
      'evt1',
    );

    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('payment.received', { orderNumber: 10042, amount: '250.50', currency: 'GHS' }),
    );
  });

  it('emails the refund for refund.succeeded.v1 with its amount, reason label, units and delivery fee', async () => {
    const { sender, dispatcher, prisma } = buildSender();

    await sender.send('refund.succeeded.v1', event({ orderId: 'order1', refundId: 'rf1' }), 'evt1');

    expect(prisma.refund.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rf1' } }));
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      orderEmail('refund.processed', {
        orderNumber: 10042,
        amount: '128.50',
        currency: 'GHS',
        reasonLabel: 'Item arrived damaged',
        lines: [{ productName: 'Kente scarf', quantity: 2 }],
        includesShipping: true,
      }),
    );
  });

  it('skips a refund email with a warning when the refund no longer exists', async () => {
    const { sender, dispatcher, logger } = buildSender(ORDER, null);

    await sender.send('refund.succeeded.v1', event({ orderId: 'order1', refundId: 'gone' }), 'evt1');

    expect(dispatcher.deliver).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refundId: gone'), 'NotificationSender');
  });

  it('logs a COD remittance discrepancy with ids only and notifies nobody', async () => {
    const { sender, dispatcher, logger } = buildSender();

    await sender.send(
      'cod.remittance_discrepancy.v1',
      event({ remittanceId: 'rem1', riderId: 'rider1', kind: 'SHORT' }),
      'evt1',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'COD remittance discrepancy | remittanceId: rem1 | riderId: rider1 | kind: SHORT',
      'NotificationSender',
    );
    expect(dispatcher.deliver).not.toHaveBeenCalled();
  });

  it('skips with a warning, and does not fail, when the order no longer exists', async () => {
    const { sender, dispatcher, logger } = buildSender(null);

    await expect(sender.send('order.placed.v1', event({ orderId: 'gone' }), 'evt1')).resolves.toBeUndefined();

    expect(dispatcher.deliver).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('orderId: gone'), 'NotificationSender');
  });

  it.each([
    ['email.welcome.v1', { to: 'kwame@gmail.com', name: 'Kwame' }, 'account.welcome', { name: 'Kwame' }],
    [
      'email.verification.v1',
      { to: 'kwame@gmail.com', verificationToken: 'tok', expiresInHours: 24 },
      'account.email_verification',
      { verificationToken: 'tok', expiresInHours: 24 },
    ],
    [
      'email.change_requested.v1',
      { to: 'kwame@gmail.com', newEmail: 'attacker.mailbox@evil.example' },
      'account.email_change_requested',
      { maskedNewEmail: 'a***@evil.example' },
    ],
    [
      'email.password_reset.v1',
      { to: 'kwame@gmail.com', resetToken: 'tok.en' },
      'account.password_reset',
      { resetUrl: 'https://shop.example.com/reset-password#token=tok.en', expiresInMinutes: 15 },
    ],
  ] as const)('sends %s from the job data to the account and row it names', async (name, data, template, rendered) => {
    const { sender, dispatcher, prisma } = buildSender();

    await sender.send(name, { ...data, userId: 'user9', dedupeKey: 'direct:abc' }, 'job7');

    expect(dispatcher.deliver).toHaveBeenCalledWith({
      dedupeKey: 'direct:abc',
      userId: 'user9',
      template,
      data: rendered,
      channel: 'EMAIL',
      to: 'kwame@gmail.com',
      idempotencyKey: 'job7',
    });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('finds the account of a job queued before P6-N.1 by its address and keys the row on the job id', async () => {
    const { sender, dispatcher, prisma } = buildSender();

    await sender.send('email.welcome.v1', { to: 'kwame@gmail.com', name: '' }, 'job8');

    expect(prisma.user.findFirst).toHaveBeenCalled();
    expect(dispatcher.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'job8:EMAIL', userId: 'user1', data: { name: null } }),
    );
  });

  it('propagates a failed send so the queue retries it', async () => {
    const { sender, dispatcher } = buildSender();
    dispatcher.deliver.mockRejectedValue(new Error('Email not delivered'));

    await expect(
      sender.send('payment.succeeded.v1', event({ orderId: 'order1', paymentId: 'pay1', amount: '1.00' }), 'evt1'),
    ).rejects.toThrow('Email not delivered');
  });

  it('texts the phone verification code for sms.phone_otp.v1 under the row queued with it', async () => {
    const { sender, dispatcher } = buildSender();

    await sender.send(
      'sms.phone_otp.v1',
      { to: '+233244123456', code: '123456', expiresInMinutes: 10, userId: 'user1', dedupeKey: 'direct:otp' },
      'job1',
    );

    expect(dispatcher.deliver).toHaveBeenCalledWith({
      dedupeKey: 'direct:otp',
      userId: 'user1',
      template: 'account.phone_otp',
      data: { code: '123456', expiresInMinutes: 10 },
      channel: 'SMS',
      to: '+233244123456',
    });
  });

  it('stores inventory.low_stock.v1 as a pending alert keyed on the event id, and emails nobody yet', async () => {
    const { sender, lowStockAlerts, dispatcher } = buildSender();
    const payload = { variantId: 'v1', locationId: 'store_main', available: 2, movementId: 'mv1' };

    await sender.send('inventory.low_stock.v1', event(payload), 'evt1');

    expect(lowStockAlerts.recordPending).toHaveBeenCalledWith('evt1', payload);
    expect(dispatcher.deliver).not.toHaveBeenCalled();
  });

  it('emails one staff member their low-stock digest, reading the address and the digest when sending', async () => {
    const { sender, lowStockAlerts, dispatcher, prisma } = buildSender();

    await sender.send('inventory.low_stock_digest.v1', event({ digestId: 'dg1', recipientId: 'staff1' }), 'evt9');

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff1' } }));
    expect(lowStockAlerts.digestSections).toHaveBeenCalledWith('dg1');
    expect(dispatcher.deliver).toHaveBeenCalledWith({
      dedupeKey: 'evt9:EMAIL',
      userId: 'staff1',
      template: 'inventory.low_stock_digest',
      data: { sections: [SECTION] },
      channel: 'EMAIL',
      to: 'ama@store.example',
      idempotencyKey: 'evt9',
    });
  });

  it('skips the digest with a warning (ids only) when the staff member is gone or deactivated', async () => {
    const { sender, dispatcher, prisma, logger } = buildSender();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'staff1', email: 'gone@store.example', isActive: false });

    await sender.send('inventory.low_stock_digest.v1', event({ digestId: 'dg1', recipientId: 'staff1' }), 'evt9');

    expect(dispatcher.deliver).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('userId: staff1'), 'NotificationSender');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('gone@store.example');
  });

  it('fails a job with an unknown name', async () => {
    await expect(buildSender().sender.send('sms.send.v1', {}, 'job1')).rejects.toThrow(
      'Unknown notification job "sms.send.v1"',
    );
  });
});

describe('passwordResetUrl', () => {
  it('puts the encoded token in the fragment of the frontend reset page', () => {
    expect(passwordResetUrl('https://shop.example.com/', 'a.b+c')).toBe(
      'https://shop.example.com/reset-password#token=a.b%2Bc',
    );
  });
});
