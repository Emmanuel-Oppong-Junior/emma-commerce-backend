import { NotificationsService } from './notifications.service';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function buildNotificationsService() {
  const emailService = {
    sendWelcomeEmail: jest.fn(),
    sendOrderConfirmationEmail: jest.fn(),
    sendOrderStatusEmail: jest.fn(),
    sendPaymentConfirmationEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendEmailVerificationEmail: jest.fn(),
    sendEmailChangeRequestedEmail: jest.fn(),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service: new NotificationsService(emailService as never, logger as never), emailService, logger };
}

describe('NotificationsService', () => {
  const sends: [string, (service: NotificationsService) => void, string][] = [
    ['sendWelcomeEmail', (s) => s.sendWelcomeEmail('kwame@gmail.com', 'Kwame'), 'sendWelcomeEmail'],
    [
      'sendOrderConfirmation',
      (s) => s.sendOrderConfirmation('kwame@gmail.com', 'o1', 10),
      'sendOrderConfirmationEmail',
    ],
    [
      'sendOrderStatusUpdate',
      (s) => s.sendOrderStatusUpdate('kwame@gmail.com', 'o1', 'SHIPPED'),
      'sendOrderStatusEmail',
    ],
    [
      'sendPaymentConfirmation',
      (s) => s.sendPaymentConfirmation('kwame@gmail.com', 'o1', 10),
      'sendPaymentConfirmationEmail',
    ],
    ['sendPasswordReset', (s) => s.sendPasswordReset('kwame@gmail.com', 'token-123'), 'sendPasswordResetEmail'],
    [
      'sendEmailVerification',
      (s) => s.sendEmailVerification('kwame@gmail.com', 'token-123', 24),
      'sendEmailVerificationEmail',
    ],
    [
      'sendEmailChangeRequested',
      (s) => s.sendEmailChangeRequested('kwame@gmail.com', 'new@gmail.com'),
      'sendEmailChangeRequestedEmail',
    ],
  ];

  it.each(sends)('%s logs a rejected send instead of leaving it unhandled', async (_name, send, emailMethod) => {
    const { service, emailService, logger } = buildNotificationsService();
    emailService[emailMethod as keyof typeof emailService].mockRejectedValue(new Error('template exploded'));

    send(service);
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Email notification failed'),
      expect.any(String),
      'NotificationsService',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('kwame@gmail.com');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('token-123');
  });

  it('passes the payment details through to the email service', () => {
    const { service, emailService } = buildNotificationsService();
    emailService.sendPaymentConfirmationEmail.mockResolvedValue(undefined);

    service.sendPaymentConfirmation('kwame@gmail.com', 'order-1', 250);

    expect(emailService.sendPaymentConfirmationEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order-1', 250);
  });
});
