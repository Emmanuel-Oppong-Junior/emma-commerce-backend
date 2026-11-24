import { NotificationDispatcher } from './notification-dispatcher';

function build(row: Partial<{ status: string; category: string; channel: string }> = {}) {
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
    markSkipped: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    consentFacts: jest.fn().mockResolvedValue({ marketingConsent: false, phoneVerified: false }),
  };
  const email = { send: jest.fn().mockResolvedValue({ messageId: 'em-1' }) };
  const sms = { send: jest.fn().mockResolvedValue({ messageId: 'sms-1' }) };
  const logger = { log: jest.fn() };
  const dispatcher = new NotificationDispatcher(notifications as never, email as never, sms as never, logger as never);
  return { dispatcher, notifications, email, sms, logger };
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
    expect(notifications.markSent).toHaveBeenCalledWith('n1', 'em-1');
  });

  it('sends an SMS rendered from the template, naming the template as its purpose', async () => {
    const { dispatcher, notifications, sms } = build({ channel: 'SMS' });

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
    expect(notifications.markSent).toHaveBeenCalledWith('n1', 'sms-1');
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

  it('marks the row FAILED (one more attempt) and rethrows so the queue retries', async () => {
    const { dispatcher, notifications, email } = build();
    email.send.mockRejectedValue(new Error('Email not delivered: quota'));

    await expect(dispatcher.deliver(PAID)).rejects.toThrow('Email not delivered: quota');

    expect(notifications.markFailed).toHaveBeenCalledWith('n1', 'PROVIDER_ERROR', true);
    expect(notifications.markSent).not.toHaveBeenCalled();
  });
});
