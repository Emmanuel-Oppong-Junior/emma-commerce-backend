import { NotificationsService } from './notifications.service';
import { TOKEN_EMAIL_JOB_OPTIONS } from './email-jobs';
import { PHONE_OTP_JOB_OPTIONS } from './sms/sms-jobs';
import { runWithCorrelation } from '../commons/correlation';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function buildNotificationsService() {
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const repository = {
    findOrCreate: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    service: new NotificationsService(queue as never, repository as never, logger as never),
    queue,
    repository,
    logger,
  };
}

const DIRECT = { userId: 'user1', dedupeKey: expect.stringMatching(/^direct:[0-9a-f-]{36}$/) as unknown };

describe('NotificationsService', () => {
  const sends: [string, (service: NotificationsService) => void, string, string, object, object | undefined][] = [
    [
      'sendWelcomeEmail',
      (s) => s.sendWelcomeEmail('user1', 'kwame@gmail.com', 'Kwame'),
      'email.welcome.v1',
      'account.welcome',
      { to: 'kwame@gmail.com', name: 'Kwame' },
      undefined,
    ],
    [
      'sendPasswordReset',
      (s) => s.sendPasswordReset('user1', 'kwame@gmail.com', 'token-123'),
      'email.password_reset.v1',
      'account.password_reset',
      { to: 'kwame@gmail.com', resetToken: 'token-123' },
      TOKEN_EMAIL_JOB_OPTIONS,
    ],
    [
      'sendEmailVerification',
      (s) => s.sendEmailVerification('user1', 'kwame@gmail.com', 'token-123', 24),
      'email.verification.v1',
      'account.email_verification',
      { to: 'kwame@gmail.com', verificationToken: 'token-123', expiresInHours: 24 },
      TOKEN_EMAIL_JOB_OPTIONS,
    ],
    [
      'sendEmailChangeRequested',
      (s) => s.sendEmailChangeRequested('user1', 'kwame@gmail.com', 'new@gmail.com'),
      'email.change_requested.v1',
      'account.email_change_requested',
      { to: 'kwame@gmail.com', newEmail: 'new@gmail.com' },
      undefined,
    ],
  ];

  it.each(sends)(
    '%s writes the QUEUED Notification row, then queues one email job naming it',
    async (_name, send, jobName, template, data, opts) => {
      const { service, queue, repository } = buildNotificationsService();

      send(service);
      await flushPromises();

      expect(repository.findOrCreate).toHaveBeenCalledWith({ ...DIRECT, template, channel: 'EMAIL' });
      const { dedupeKey } = repository.findOrCreate.mock.calls[0][0] as { dedupeKey: string };
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(jobName, { ...data, userId: 'user1', dedupeKey }, opts);
    },
  );

  it('tags the job with the request that queued it', async () => {
    const { service, queue } = buildNotificationsService();

    runWithCorrelation({ requestId: 'req-1' }, () => service.sendWelcomeEmail('user1', 'kwame@gmail.com', 'Kwame'));
    await flushPromises();

    expect(queue.add).toHaveBeenCalledWith(
      'email.welcome.v1',
      { to: 'kwame@gmail.com', name: 'Kwame', ...DIRECT, meta: { requestId: 'req-1' } },
      undefined,
    );
  });

  it('removes token-bearing jobs from Redis once sent', () => {
    expect(TOKEN_EMAIL_JOB_OPTIONS.removeOnComplete).toBe(true);
  });

  it.each(sends)(
    '%s logs a queueing failure without the address or token, marks the row FAILED, and never throws',
    async (_name, send) => {
      const { service, queue, repository, logger } = buildNotificationsService();
      queue.add.mockRejectedValue(new Error('Redis connection lost'));

      expect(() => send(service)).not.toThrow();
      await flushPromises();
      await flushPromises();

      expect(repository.markFailed).toHaveBeenCalledWith('notif-1', 'QUEUE_ERROR', false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Email could not be queued'),
        'Redis connection lost',
        'NotificationsService',
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('kwame@gmail.com');
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('token-123');
    },
  );

  it('queues the phone code SMS with its row and fails the caller when it cannot be queued', async () => {
    const { service, queue, repository } = buildNotificationsService();

    await service.queuePhoneOtpSms('user1', '+233244123456', '123456', 10);
    expect(repository.findOrCreate).toHaveBeenCalledWith({ ...DIRECT, template: 'account.phone_otp', channel: 'SMS' });
    expect(queue.add).toHaveBeenCalledWith(
      'sms.phone_otp.v1',
      { to: '+233244123456', code: '123456', expiresInMinutes: 10, ...DIRECT },
      PHONE_OTP_JOB_OPTIONS,
    );

    queue.add.mockRejectedValue(new Error('Redis connection lost'));
    await expect(service.queuePhoneOtpSms('user1', '+233244123456', '123456', 10)).rejects.toThrow(
      'Redis connection lost',
    );
    expect(repository.markFailed).toHaveBeenCalledWith('notif-1', 'QUEUE_ERROR', false);
  });
});
