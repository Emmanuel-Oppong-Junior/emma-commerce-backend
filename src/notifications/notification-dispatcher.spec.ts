import { NotificationDispatcher } from './notification-dispatcher';

function build(row: Partial<{ status: string; category: string; channel: string; templateKey: string }> = {}) {
  const notifications = {
    findOrCreate: jest.fn().mockResolvedValue({
      id: 'n1',
      status: 'QUEUED',
      category: 'TRANSACTIONAL',
      templateKey: 'payment.received',
      channel: 'EMAIL',
      ...row,
    }),
    markSent: jest.fn().mockResolvedValue(undefined),
    markSentInApp: jest.fn().mockResolvedValue(undefined),
    markSkipped: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    consentFacts: jest.fn().mockResolvedValue({ marketingConsent: false, phoneVerified: false }),
  };
  const email = { send: jest.fn().mockResolvedValue({ messageId: 'em-1' }) };
  const sms = { send: jest.fn().mockResolvedValue({ messageId: 'sms-1', status: '0' }) };
  const logger = { log: jest.fn() };
  const metrics = { recordSms: jest.fn() };
  const dispatcher = new NotificationDispatcher(
    notifications as never,
    email as never,
    sms as never,
    logger as never,
    metrics as never,
  );
  return { dispatcher, notifications, email, sms, logger, metrics };
}

const PAID = {
  dedupeKey: 'evt1:EMAIL',
  userId: 'user1',
  template: 'payment.received' as const,
  data: { orderNumber: 10042, amount: '99', currency: 'GHS' },
  channel: 'EMAIL' as const,
  to: 'kwame@gmail.com',
  idempotencyKey: 'evt1',
};

describe('NotificationDispatcher', () => {
  it('renders and sends a transactional email, then marks its row SENT with the provider message id', async () => {
    const { dispatcher, notifications, email } = build();

    await expect(dispatcher.deliver(PAID)).resolves.toBe('SENT');

    expect(notifications.findOrCreate).toHaveBeenCalledWith(PAID);
    expect(notifications.consentFacts).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledWith(
      'kwame@gmail.com',
      expect.objectContaining({ subject: 'Payment received for order #10042' }),
      'evt1',
    );
    expect(notifications.markSent).toHaveBeenCalledWith('n1', 'em-1', null);
  });

  it('sends an SMS rendered from the template, storing the provider status and counting it per template', async () => {
    const { dispatcher, notifications, sms, metrics } = build({ channel: 'SMS', templateKey: 'shipment.delivered' });

    await dispatcher.deliver({
      dedupeKey: 'j:SMS',
      userId: 'user1',
      template: 'shipment.delivered',
      data: { orderNumber: 7 },
      channel: 'SMS',
      to: '+233244123456',
    });

    expect(sms.send).toHaveBeenCalledWith(
      '+233244123456',
      'Your order #7 has been delivered. Thank you for shopping with us.',
      'shipment.delivered',
    );
    expect(notifications.markSent).toHaveBeenCalledWith('n1', 'sms-1', '0');
    expect(metrics.recordSms).toHaveBeenCalledWith('shipment.delivered', 'sent');
  });

  it('delivers an in-app notification by storing its title, body and link (no address needed)', async () => {
    const { dispatcher, notifications, email, sms } = build({ channel: 'IN_APP' });

    await expect(
      dispatcher.deliver({
        ...PAID,
        dedupeKey: 'evt1:IN_APP',
        channel: 'IN_APP',
        to: null,
        ref: { type: 'Order', id: 'o1' },
      }),
    ).resolves.toBe('SENT');

    expect(notifications.markSentInApp).toHaveBeenCalledWith(
      'n1',
      { title: 'Payment received', body: 'We received your payment of GHS 99.00 for order #10042.' },
      { type: 'Order', id: 'o1' },
    );
    expect(email.send).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(notifications.markSkipped).not.toHaveBeenCalled();
  });

  it.each(['SENT', 'SKIPPED'])('sends nothing again for a row already %s (the job ran again)', async (status) => {
    const { dispatcher, email, notifications } = build({ status });

    await expect(dispatcher.deliver(PAID)).resolves.toBe(status);

    expect(email.send).not.toHaveBeenCalled();
    expect(notifications.markSent).not.toHaveBeenCalled();
  });

  it('retries a FAILED row', async () => {
    const { dispatcher, email } = build({ status: 'FAILED' });

    await dispatcher.deliver(PAID);

    expect(email.send).toHaveBeenCalled();
  });

  it('skips marketing without consent at send time (NO_CONSENT), reading consent for the channel', async () => {
    const { dispatcher, notifications, email } = build({ category: 'MARKETING' });

    await expect(dispatcher.deliver(PAID)).resolves.toBe('SKIPPED');

    expect(notifications.consentFacts).toHaveBeenCalledWith('user1', 'EMAIL');
    expect(notifications.markSkipped).toHaveBeenCalledWith('n1', 'NO_CONSENT');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends marketing with consent', async () => {
    const { dispatcher, notifications, email } = build({ category: 'MARKETING' });
    notifications.consentFacts.mockResolvedValue({ marketingConsent: true, phoneVerified: false });

    await expect(dispatcher.deliver(PAID)).resolves.toBe('SENT');
    expect(email.send).toHaveBeenCalled();
  });

  it('skips a message with no address (NO_ADDRESS) and one with no provider outside production (NOT_CONFIGURED)', async () => {
    const noAddress = build();
    await expect(noAddress.dispatcher.deliver({ ...PAID, to: null })).resolves.toBe('SKIPPED');
    expect(noAddress.notifications.markSkipped).toHaveBeenCalledWith('n1', 'NO_ADDRESS');

    const noProvider = build();
    noProvider.email.send.mockResolvedValue(null);
    await expect(noProvider.dispatcher.deliver(PAID)).resolves.toBe('SKIPPED');
    expect(noProvider.notifications.markSkipped).toHaveBeenCalledWith('n1', 'NOT_CONFIGURED');
  });

  it('counts failed and skipped SMS, and never counts other channels', async () => {
    const failing = build({ channel: 'SMS', templateKey: 'account.phone_otp' });
    failing.sms.send.mockRejectedValue(new Error('Hubtel SMS refused: HTTP 401'));
    const otp = { ...PAID, template: 'account.phone_otp' as const, data: { code: '1', expiresInMinutes: 10 } };
    await expect(failing.dispatcher.deliver({ ...otp, channel: 'SMS', to: '+233244123456' })).rejects.toThrow(
      'HTTP 401',
    );
    expect(failing.metrics.recordSms).toHaveBeenCalledWith('account.phone_otp', 'failed');

    const noPhone = build({ channel: 'SMS', templateKey: 'account.phone_otp' });
    await noPhone.dispatcher.deliver({ ...otp, channel: 'SMS', to: null });
    expect(noPhone.metrics.recordSms).toHaveBeenCalledWith('account.phone_otp', 'skipped');

    const email = build();
    await email.dispatcher.deliver(PAID);
    expect(email.metrics.recordSms).not.toHaveBeenCalled();
  });

  it('marks the row FAILED (one more attempt) and rethrows so the queue retries', async () => {
    const { dispatcher, notifications, email } = build();
    email.send.mockRejectedValue(new Error('Email not delivered: quota'));

    await expect(dispatcher.deliver(PAID)).rejects.toThrow('Email not delivered: quota');

    expect(notifications.markFailed).toHaveBeenCalledWith('n1', 'PROVIDER_ERROR', true);
    expect(notifications.markSent).not.toHaveBeenCalled();
  });

  describe('guests (P6-G.1)', () => {
    const GUEST_PAID = { ...PAID, userId: null, ref: { type: 'Order' as const, id: 'order1' } };

    it('sends a transactional message to a guest, its row naming the order instead of an account', async () => {
      const { dispatcher, notifications, email } = build();

      await expect(dispatcher.deliver(GUEST_PAID)).resolves.toBe('SENT');

      expect(notifications.findOrCreate).toHaveBeenCalledWith(GUEST_PAID);
      expect(email.send).toHaveBeenCalled();
    });

    it('never sends marketing to a guest: there is no consent to read', async () => {
      const { dispatcher, notifications, email } = build({ category: 'MARKETING' });

      await expect(dispatcher.deliver(GUEST_PAID)).resolves.toBe('SKIPPED');

      expect(notifications.consentFacts).not.toHaveBeenCalled();
      expect(notifications.markSkipped).toHaveBeenCalledWith('n1', 'NO_CONSENT');
      expect(email.send).not.toHaveBeenCalled();
    });

    it('refuses a message with neither a user nor what it is about', async () => {
      const { dispatcher, notifications } = build();

      await expect(dispatcher.deliver({ ...PAID, userId: null })).rejects.toThrow('needs a ref');
      expect(notifications.findOrCreate).not.toHaveBeenCalled();
    });
  });
});
