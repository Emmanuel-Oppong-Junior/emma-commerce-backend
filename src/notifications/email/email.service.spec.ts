import { EmailDeliveryError, EmailService } from './email.service';
import { renderEmail } from '../templates/templates';

const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const RECIPIENT = 'kwame.asante@gmail.com';
const MASKED_RECIPIENT = 'k***@gmail.com';
const PAID = renderEmail('payment.received', { orderNumber: 10042, amount: '120', currency: 'GHS' });

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

  it('sends subject, HTML and plain text, returns the message id and logs a masked recipient', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { service, logger } = buildEmailService('re_unit_key');

    await expect(service.send(RECIPIENT, PAID)).resolves.toEqual({ messageId: 'email-1' });

    expect(mockSend).toHaveBeenCalledWith(
      { from: 'orders@shop.test', to: RECIPIENT, subject: PAID.subject, html: PAID.html, text: PAID.text },
      { idempotencyKey: undefined },
    );
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`Email sent`), 'EmailService');
    expect(logger.error).not.toHaveBeenCalled();
    expect(allLogLines(logger)).toContain(MASKED_RECIPIENT);
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('passes the idempotency key to Resend so a retried job cannot send the email twice', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { service } = buildEmailService('re_unit_key');

    await service.send(RECIPIENT, PAID, 'evt_123');

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: RECIPIENT }), { idempotencyKey: 'evt_123' });
  });

  it('throws, without logging success, when Resend returns an error result, so the queue retries', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: 'daily_quota_exceeded', message: `Quota reached while sending to ${RECIPIENT}.` },
    });
    const { service, logger } = buildEmailService('re_unit_key');

    const failure = service.send(RECIPIENT, PAID);

    await expect(failure).rejects.toThrow(EmailDeliveryError);
    await expect(failure).rejects.toThrow(/Payment received for order #10042 \| daily_quota_exceeded/);
    await expect(failure).rejects.not.toThrow(RECIPIENT);
    expect(logger.log).not.toHaveBeenCalled();
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('throws when the Resend call throws', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));
    const { service } = buildEmailService('re_unit_key');

    await expect(service.send(RECIPIENT, PAID)).rejects.toThrow(
      'Email not delivered: Payment received for order #10042 | socket hang up',
    );
  });

  it('never puts the password-reset link or token in logs or in the error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } });
    const { service, logger } = buildEmailService('re_unit_key');
    const reset = renderEmail('account.password_reset', {
      resetUrl: 'https://shop.example.com/reset-password#token=reset-token-abc123',
      expiresInMinutes: 15,
    });

    const error = await service.send(RECIPIENT, reset).catch((e: Error) => e);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as Error).message).not.toContain('reset-token-abc123');
    expect(allLogLines(logger)).not.toContain('reset-token-abc123');
  });

  it('never logs the email verification token', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } });
    const { service, logger } = buildEmailService('re_unit_key');
    const verification = renderEmail('account.email_verification', {
      verificationToken: 'verify-token-abc123',
      expiresInHours: 24,
    });

    const error = await service.send(RECIPIENT, verification).catch((e: Error) => e);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('verify-token-abc123') }),
      { idempotencyKey: undefined },
    );
    expect((error as Error).message).not.toContain('verify-token-abc123');
    expect(allLogLines(logger)).not.toContain('verify-token-abc123');
  });

  it('warns and returns null without calling Resend when RESEND_API_KEY is not configured', async () => {
    const { service, logger } = buildEmailService(undefined);

    await expect(service.send(RECIPIENT, PAID)).resolves.toBeNull();

    expect(mockSend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MASKED_RECIPIENT), 'EmailService');
  });
});
