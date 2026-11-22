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

function buildSender(order: typeof ORDER | null = ORDER, refund: typeof REFUND | null = REFUND) {
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
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
  return {
    sms,
    lowStockAlerts,
    sender: new NotificationSender(
      prisma as never,
      email as never,
      sms as never,
      logger as never,
      lowStockAlerts as never,
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

  it.each(['OUT_FOR_DELIVERY', 'READY_FOR_PICKUP'])(
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

  it('emails nobody for a shipment step that is not a dispatch', async () => {
    const { sender, email } = buildSender();

    await sender.send(
      'shipment.status_changed.v1',
      event({ orderId: 'order1', shipmentId: 'ship1', status: 'FAILED_DELIVERY', trackingNumber: null }),
      'evt1',
    );

    expect(email.sendOrderStatusEmail).not.toHaveBeenCalled();
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
