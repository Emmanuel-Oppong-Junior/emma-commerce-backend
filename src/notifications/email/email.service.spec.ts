import { EmailDeliveryError, EmailService } from './email.service';

const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const RECIPIENT = 'kwame.asante@gmail.com';
const MASKED_RECIPIENT = 'k***@gmail.com';

function buildEmailService(resendApiKey: string | undefined) {
  const config = {
    get: jest.fn((key: string) => (key === 'RESEND_API_KEY' ? resendApiKey : 'orders@shop.test')),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service: new EmailService(config as never, logger as never), logger };
}

const allLogLines = (logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock }) =>
  JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);

describe('EmailService', () => {
  beforeEach(() => mockSend.mockReset());

  it('logs success with a masked recipient when Resend accepts the email', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { service, logger } = buildEmailService('re_test_key');

    await service.sendOrderConfirmationEmail(RECIPIENT, 'order-1', '120.00');

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`Email sent`), 'EmailService');
    expect(logger.error).not.toHaveBeenCalled();
    expect(allLogLines(logger)).toContain(MASKED_RECIPIENT);
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('passes the idempotency key to Resend so a retried job cannot send the email twice', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { service } = buildEmailService('re_test_key');

    await service.sendOrderConfirmationEmail(RECIPIENT, 'order-1', '120.00', 'evt_123');

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: RECIPIENT }), { idempotencyKey: 'evt_123' });
  });

  it('throws, without logging success, when Resend returns an error result, so the queue retries', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: 'daily_quota_exceeded', message: `Quota reached while sending to ${RECIPIENT}.` },
    });
    const { service, logger } = buildEmailService('re_test_key');

    const failure = service.sendOrderConfirmationEmail(RECIPIENT, 'order-1', '120.00');

    await expect(failure).rejects.toThrow(EmailDeliveryError);
    await expect(failure).rejects.toThrow(/Order Confirmed – #order-1 \| daily_quota_exceeded/);
    await expect(failure).rejects.not.toThrow(RECIPIENT);
    expect(logger.log).not.toHaveBeenCalled();
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('throws when the Resend call throws', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));
    const { service } = buildEmailService('re_test_key');

    await expect(service.sendPaymentConfirmationEmail(RECIPIENT, 'order-1', '120.00')).rejects.toThrow(
      'Email not delivered: Payment received for order #order-1 | socket hang up',
    );
  });

  it('never puts the password-reset token in logs or in the error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } });
    const { service, logger } = buildEmailService('re_test_key');

    const error = await service.sendPasswordResetEmail(RECIPIENT, 'reset-token-abc123').catch((e: Error) => e);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as Error).message).not.toContain('reset-token-abc123');
    expect(allLogLines(logger)).not.toContain('reset-token-abc123');
  });

  it('never logs the email verification token', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } });
    const { service, logger } = buildEmailService('re_test_key');

    const error = await service.sendEmailVerificationEmail(RECIPIENT, 'verify-token-abc123', 24).catch((e: Error) => e);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('verify-token-abc123') }),
      { idempotencyKey: undefined },
    );
    expect((error as Error).message).not.toContain('verify-token-abc123');
    expect(allLogLines(logger)).not.toContain('verify-token-abc123');
  });

  it('shows the old address only a masked form of the requested new address', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-2' }, error: null });
    const { service } = buildEmailService('re_test_key');

    await service.sendEmailChangeRequestedEmail(RECIPIENT, 'attacker.mailbox@evil.example');

    const { to, html } = mockSend.mock.calls[0][0];
    expect(to).toBe(RECIPIENT);
    expect(html).toContain('a***@evil.example');
    expect(html).not.toContain('attacker.mailbox');
  });

  it('warns without calling Resend when RESEND_API_KEY is not configured', async () => {
    const { service, logger } = buildEmailService(undefined);

    await service.sendWelcomeEmail(RECIPIENT, 'Kwame');

    expect(mockSend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MASKED_RECIPIENT), 'EmailService');
  });
});
