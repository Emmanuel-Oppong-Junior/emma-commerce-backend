import { NotificationsService } from './notifications.service';
import { TOKEN_EMAIL_JOB_OPTIONS } from './email-jobs';
import { runWithCorrelation } from '../commons/correlation';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function buildNotificationsService() {
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service: new NotificationsService(queue as never, logger as never), queue, logger };
}

describe('NotificationsService', () => {
  const sends: [string, (service: NotificationsService) => void, string, object, object | undefined][] = [
    [
      'sendWelcomeEmail',
      (s) => s.sendWelcomeEmail('kwame@gmail.com', 'Kwame'),
      'email.welcome.v1',
      { to: 'kwame@gmail.com', name: 'Kwame' },
      undefined,
    ],
    [
      'sendPasswordReset',
      (s) => s.sendPasswordReset('kwame@gmail.com', 'token-123'),
      'email.password_reset.v1',
      { to: 'kwame@gmail.com', resetToken: 'token-123' },
      TOKEN_EMAIL_JOB_OPTIONS,
    ],
    [
      'sendEmailVerification',
      (s) => s.sendEmailVerification('kwame@gmail.com', 'token-123', 24),
      'email.verification.v1',
      { to: 'kwame@gmail.com', verificationToken: 'token-123', expiresInHours: 24 },
      TOKEN_EMAIL_JOB_OPTIONS,
    ],
    [
      'sendEmailChangeRequested',
      (s) => s.sendEmailChangeRequested('kwame@gmail.com', 'new@gmail.com'),
      'email.change_requested.v1',
      { to: 'kwame@gmail.com', newEmail: 'new@gmail.com' },
      undefined,
    ],
  ];

  it.each(sends)('%s queues one email job for the worker', (_name, send, jobName, data, opts) => {
    const { service, queue } = buildNotificationsService();

    send(service);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(jobName, data, opts);
  });

  it('tags the job with the request that queued it', () => {
    const { service, queue } = buildNotificationsService();

    runWithCorrelation({ requestId: 'req-1' }, () => service.sendWelcomeEmail('kwame@gmail.com', 'Kwame'));

    expect(queue.add).toHaveBeenCalledWith(
      'email.welcome.v1',
      { to: 'kwame@gmail.com', name: 'Kwame', meta: { requestId: 'req-1' } },
      undefined,
    );
  });

  it('removes token-bearing jobs from Redis once sent', () => {
    expect(TOKEN_EMAIL_JOB_OPTIONS.removeOnComplete).toBe(true);
  });

  it.each(sends)('%s logs a queueing failure without the address or token, and never throws', async (_name, send) => {
    const { service, queue, logger } = buildNotificationsService();
    queue.add.mockRejectedValue(new Error('Redis connection lost'));

    expect(() => send(service)).not.toThrow();
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Email could not be queued'),
      'Redis connection lost',
      'NotificationsService',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('kwame@gmail.com');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('token-123');
  });
});
