import { Prisma } from '../generated/prisma/client';
import { NotificationSender } from './notification-sender';

const ORDER = { id: 'order1', grandTotal: new Prisma.Decimal('250.5'), user: { email: 'kwame@gmail.com' } };

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
    contactPhone: '0243333333',
    shippingAddressSnapshot: { phone: '0242222222' },
    user: { phoneNumber: null, phoneVerifiedAt: null, phoneVerifiedNumber: null },
  },
};

function buildSender(order: typeof ORDER | null = ORDER, refund: typeof REFUND | null = REFUND) {
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    shipment: { findUnique: jest.fn().mockResolvedValue(SHIPMENT) },
    refund: { findUnique: jest.fn().mockResolvedValue(refund) },
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'ama@store.example', isActive: true }) },
  };
  const email = {
    sendRefundEmail: jest.fn().mockResolvedValue(undefined),
    sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
    sendOrderConfirmationEmail: jest.fn().mockResolvedValue(undefined),
    sendOrderStatusEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentConfirmationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    sendEmailVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendEmailChangeRequestedEmail: jest.fn().mockResolvedValue(undefined),
    sendLowStockDigestEmail: jest.fn().mockResolvedValue(undefined),
  };
  const sms = { send: jest.fn().mockResolvedValue(undefined) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const lowStockAlerts = {
    recordPending: jest.fn().mockResolvedValue(true),
    digestSections: jest.fn().mockResolvedValue([SECTION]),
  };
  const notifications = { queueShipmentSms: jest.fn().mockResolvedValue(undefined) };
  const readyForPickup = { notify: jest.fn().mockResolvedValue(undefined) };
  return {
    sms,
    lowStockAlerts,
    notifications,
    readyForPickup,
    sender: new NotificationSender(
      prisma as never,
      email as never,
      sms as never,
      logger as never,
      lowStockAlerts as never,
      notifications as never,
      readyForPickup as never,
    ),
    prisma,
    email,
    logger,
  };
}

const event = (payload: object) => ({ eventId: 'evt1', aggregateId: 'order1', payload });

describe('NotificationSender', () => {
  it('sends the order confirmation for order.placed.v1, reading the recipient and total when sending', async () => {
    const { sender, prisma, email } = buildSender();

    await sender.send('order.placed.v1', event({ orderId: 'order1' }), 'evt1');

    expect(prisma.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order1' } }));
    expect(email.sendOrderConfirmationEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', '250.50', 'evt1');
  });

  it('sends the status email for order.status_changed.v1 with its tracking number', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'order.status_changed.v1',
      event({ orderId: 'order1', status: 'SHIPPED', trackingNumber: 'TRK1' }),
      'evt1',
    );

    expect(email.sendOrderStatusEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', 'SHIPPED', 'TRK1', 'evt1');
  });

  it('sends the status email without a tracking number when the event has none', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'order.status_changed.v1',
      event({ orderId: 'order1', status: 'DELIVERED', trackingNumber: null }),
      'evt1',
    );

    expect(email.sendOrderStatusEmail).toHaveBeenCalledWith(
      'kwame@gmail.com',
      'order1',
      'DELIVERED',
      undefined,
      'evt1',
    );
  });

  it('sends the SHIPPED email for order.shipment_updated.v1', async () => {
    const { sender, email } = buildSender();

    await sender.send('order.shipment_updated.v1', event({ orderId: 'order1', trackingNumber: 'TRK9' }), 'evt1');

    expect(email.sendOrderStatusEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', 'SHIPPED', 'TRK9', 'evt1');
  });

  it('emails a completed order for order.status_changed.v2 and nobody for other statuses', async () => {
    const { sender, email, prisma } = buildSender();

    await sender.send(
      'order.status_changed.v2',
      event({ orderId: 'order1', from: 'IN_FULFILMENT', to: 'COMPLETED' }),
      'evt1',
    );
    await sender.send('order.status_changed.v2', event({ orderId: 'order1', from: 'PLACED', to: 'CANCELLED' }), 'evt2');

    expect(email.sendOrderStatusEmail).toHaveBeenCalledTimes(1);
    expect(email.sendOrderStatusEmail).toHaveBeenCalledWith(
      'kwame@gmail.com',
      'order1',
      'COMPLETED',
      undefined,
      'evt1',
    );
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });

  // P5-E.1: READY_FOR_PICKUP no longer gets this generic email; it has its own email and SMS (below).
  it.each(['OUT_FOR_DELIVERY'])(
    'emails the dispatch for shipment.status_changed.v1 (%s) with its tracking number',
    async (status) => {
      const { sender, email } = buildSender();

      await sender.send(
        'shipment.status_changed.v1',
        event({ orderId: 'order1', shipmentId: 'ship1', status, trackingNumber: 'TRK1' }),
        'evt1',
      );

      expect(email.sendOrderStatusEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', status, 'TRK1', 'evt1');
    },
  );

  it('hands READY_FOR_PICKUP to the pickup notice (email and SMS) instead of the dispatch email', async () => {
    const { sender, email, readyForPickup } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status: 'READY_FOR_PICKUP', trackingNumber: null }),
      'evt1',
    );

    expect(readyForPickup.notify).toHaveBeenCalledWith('order1', 'evt1');
    expect(email.sendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it('texts the ready-for-pickup SMS with the order number, place and hours', async () => {
    const { sender, sms } = buildSender();
    const notice = {
      orderNumber: 10023,
      pickupName: 'Osu Store',
      address: '12 Oxford St, Accra',
      hours: 'Mon-Fri 08:00-17:00, Sat-Sun closed',
      contactPhone: null,
      instructions: null,
    };

    await sender.send('sms.ready_for_pickup.v1', { to: '+233244123456', notice }, 'evt1-sms');

    expect(sms.send).toHaveBeenCalledWith(
      '+233244123456',
      'Order #10023 is ready for pickup at Osu Store, 12 Oxford St, Accra. Open: Mon-Fri 08:00-17:00, Sat-Sun closed.',
      'ready_for_pickup',
    );
  });

  it('emails nobody for a shipment step that is not a dispatch', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status: 'FAILED_DELIVERY', trackingNumber: null }),
      'evt1',
    );

    expect(email.sendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it.each(['OUT_FOR_DELIVERY', 'DELIVERED'])(
    'queues the milestone SMS for shipment.status_changed.v1 (%s) under a job id derived from the event',
    async (status) => {
      const { sender, notifications, sms } = buildSender();

      await sender.send(
        'shipment.status_changed.v1',
        event({ orderId: 'order1', shipmentId: 'ship1', status, trackingNumber: 'TRK1' }),
        'evt1',
      );

      expect(notifications.queueShipmentSms).toHaveBeenCalledWith(
        { orderId: 'order1', shipmentId: 'ship1', status },
        'evt1-sms',
      );
      expect(sms.send).not.toHaveBeenCalled();
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
    const { sender, sms, prisma } = buildSender();

    await sender.send(
      'sms.shipment_milestone.v1',
      { orderId: 'order1', shipmentId: 'ship1', status: 'OUT_FOR_DELIVERY' },
      'evt1-sms',
    );

    expect(prisma.shipment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ship1' } }));
    expect(sms.send).toHaveBeenCalledWith(
      '+233242222222',
      'Your order #1042 is out for delivery with DHL. Tracking number: TRK1.',
      'shipment_out_for_delivery',
    );
  });

  it('texts the verified account phone first', async () => {
    const { sender, sms, prisma } = buildSender();
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

    expect(sms.send).toHaveBeenCalledWith(
      '+233201111111',
      'Your order #1042 has been delivered. Thank you for shopping with us.',
      'shipment_delivered',
    );
  });

  it('sends no milestone SMS, with a warning naming ids only, when the shipment is gone or no phone is usable', async () => {
    const { sender, sms, prisma, logger } = buildSender();
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
      'j',
    );

    expect(sms.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [message] of logger.warn.mock.calls as [string][]) expect(message).not.toContain('5550100');
  });

  it('sends the SHIPPED email for shipment.tracking_updated.v1', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'shipment.tracking_updated.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', trackingNumber: 'TRK9' }),
      'evt1',
    );

    expect(email.sendOrderStatusEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', 'SHIPPED', 'TRK9', 'evt1');
  });

  it('sends the payment confirmation for payment.succeeded.v1 with the settled amount', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'payment.succeeded.v1',
      event({ orderId: 'order1', paymentId: 'pay1', amount: '250.50' }),
      'evt1',
    );

    expect(email.sendPaymentConfirmationEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', '250.50', 'evt1');
  });

  it('emails the refund for refund.succeeded.v1 with its amount, reason label, units and delivery fee', async () => {
    const { sender, email, prisma } = buildSender();

    await sender.send('refund.succeeded.v1', event({ orderId: 'order1', refundId: 'rf1' }), 'evt1');

    expect(prisma.refund.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rf1' } }));
    expect(email.sendRefundEmail).toHaveBeenCalledWith(
      'kwame@gmail.com',
      'order1',
      {
        amount: '128.50',
        currency: 'GHS',
        reasonLabel: 'Item arrived damaged',
        lines: [{ productName: 'Kente scarf', quantity: 2 }],
        includesShipping: true,
      },
      'evt1',
    );
  });

  it('skips a refund email with a warning when the refund no longer exists', async () => {
    const { sender, email, logger } = buildSender(ORDER, null);

    await sender.send('refund.succeeded.v1', event({ orderId: 'order1', refundId: 'gone' }), 'evt1');

    expect(email.sendRefundEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refundId: gone'), 'NotificationSender');
  });

  it('logs a COD remittance discrepancy with ids only and emails nobody', async () => {
    const { sender, email, logger } = buildSender();

    await sender.send(
      'cod.remittance_discrepancy.v1',
      event({ remittanceId: 'rem1', riderId: 'rider1', kind: 'SHORT' }),
      'evt1',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'COD remittance discrepancy | remittanceId: rem1 | riderId: rider1 | kind: SHORT',
      'NotificationSender',
    );
    expect(Object.values(email).every((send) => send.mock.calls.length === 0)).toBe(true);
  });

  it('skips with a warning, and does not fail, when the order no longer exists', async () => {
    const { sender, email, logger } = buildSender(null);

    await expect(sender.send('order.placed.v1', event({ orderId: 'gone' }), 'evt1')).resolves.toBeUndefined();

    expect(email.sendOrderConfirmationEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('orderId: gone'), 'NotificationSender');
  });

  it.each([
    ['email.welcome.v1', { to: 'kwame@gmail.com', name: 'Kwame' }, 'sendWelcomeEmail', ['kwame@gmail.com', 'Kwame']],
    [
      'email.verification.v1',
      { to: 'kwame@gmail.com', verificationToken: 'tok', expiresInHours: 24 },
      'sendEmailVerificationEmail',
      ['kwame@gmail.com', 'tok', 24],
    ],
    [
      'email.change_requested.v1',
      { to: 'kwame@gmail.com', newEmail: 'new@gmail.com' },
      'sendEmailChangeRequestedEmail',
      ['kwame@gmail.com', 'new@gmail.com'],
    ],
    [
      'email.password_reset.v1',
      { to: 'kwame@gmail.com', resetToken: 'tok' },
      'sendPasswordResetEmail',
      ['kwame@gmail.com', 'tok'],
    ],
  ] as const)('sends %s directly from the job data', async (name, data, method, args) => {
    const { sender, email, prisma } = buildSender();

    await sender.send(name, data, 'job7');

    expect(email[method]).toHaveBeenCalledWith(...args, 'job7');
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('propagates a failed send so the queue retries it', async () => {
    const { sender, email } = buildSender();
    email.sendPaymentConfirmationEmail.mockRejectedValue(new Error('Email not delivered'));

    await expect(
      sender.send('payment.succeeded.v1', event({ orderId: 'order1', paymentId: 'pay1', amount: '1.00' }), 'evt1'),
    ).rejects.toThrow('Email not delivered');
  });

  it('texts the phone verification code for sms.phone_otp.v1', async () => {
    const { sender, sms } = buildSender();

    await sender.send('sms.phone_otp.v1', { to: '+233244123456', code: '123456', expiresInMinutes: 10 }, 'job1');

    expect(sms.send).toHaveBeenCalledWith(
      '+233244123456',
      '123456 is your verification code. It expires in 10 minutes. Never share it with anyone.',
      'phone_otp',
    );
  });

  it('stores inventory.low_stock.v1 as a pending alert keyed on the event id, and emails nobody yet', async () => {
    const { sender, lowStockAlerts, email } = buildSender();
    const payload = { variantId: 'v1', locationId: 'store_main', available: 2, movementId: 'mv1' };

    await sender.send('inventory.low_stock.v1', event(payload), 'evt1');

    expect(lowStockAlerts.recordPending).toHaveBeenCalledWith('evt1', payload);
    expect(email.sendLowStockDigestEmail).not.toHaveBeenCalled();
  });

  it('emails one staff member their low-stock digest, reading the address and the digest when sending', async () => {
    const { sender, lowStockAlerts, email, prisma } = buildSender();

    await sender.send('inventory.low_stock_digest.v1', event({ digestId: 'dg1', recipientId: 'staff1' }), 'evt9');

    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff1' } }));
    expect(lowStockAlerts.digestSections).toHaveBeenCalledWith('dg1');
    expect(email.sendLowStockDigestEmail).toHaveBeenCalledWith('ama@store.example', [SECTION], 'evt9');
  });

  it('skips the digest with a warning (ids only) when the staff member is gone or deactivated', async () => {
    const { sender, email, prisma, logger } = buildSender();
    prisma.user.findUnique.mockResolvedValueOnce({ email: 'gone@store.example', isActive: false });

    await sender.send('inventory.low_stock_digest.v1', event({ digestId: 'dg1', recipientId: 'staff1' }), 'evt9');

    expect(email.sendLowStockDigestEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('userId: staff1'), 'NotificationSender');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('gone@store.example');
  });

  it('fails a job with an unknown name', async () => {
    await expect(buildSender().sender.send('sms.send.v1', {}, 'job1')).rejects.toThrow(
      'Unknown notification job "sms.send.v1"',
    );
  });
});
