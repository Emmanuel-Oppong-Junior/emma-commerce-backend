import { EmailService } from './email.service';

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

    await service.sendOrderConfirmationEmail(RECIPIENT, 'order-1', 120);

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(`Email sent`), 'EmailService');
    expect(logger.error).not.toHaveBeenCalled();
    expect(allLogLines(logger)).toContain(MASKED_RECIPIENT);
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('logs an error, not success, when Resend returns an error result', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' },
    });
    const { service, logger } = buildEmailService('re_test_key');

    await service.sendOrderConfirmationEmail(RECIPIENT, 'order-1', 120);

    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to send email`),
      expect.stringContaining('daily_quota_exceeded'),
      'EmailService',
    );
    expect(allLogLines(logger)).not.toContain(RECIPIENT);
  });

  it('logs an error when the Resend call throws', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));
    const { service, logger } = buildEmailService('re_test_key');

    await service.sendPaymentConfirmationEmail(RECIPIENT, 'order-1', 120);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send email'),
      'socket hang up',
      'EmailService',
    );
  });

  it('never logs the password-reset token', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } });
    const { service, logger } = buildEmailService('re_test_key');

    await service.sendPasswordResetEmail(RECIPIENT, 'reset-token-abc123');

    expect(allLogLines(logger)).not.toContain('reset-token-abc123');
  });

  it('warns without calling Resend when RESEND_API_KEY is not configured', async () => {
    const { service, logger } = buildEmailService(undefined);

    await service.sendWelcomeEmail(RECIPIENT, 'Kwame');

    expect(mockSend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MASKED_RECIPIENT), 'EmailService');
  });
});
