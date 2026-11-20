import { Job } from 'bullmq';
import { NotificationsProcessor, SENT_MARKER_PREFIX } from './notifications.processor';

function buildProcessor(alreadySent = false) {
  const sender = { send: jest.fn().mockResolvedValue(undefined) };
  const redis = { exists: jest.fn().mockResolvedValue(alreadySent ? 1 : 0), set: jest.fn().mockResolvedValue('OK') };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const processor = new NotificationsProcessor(sender as never, redis as never, logger as never);
  return { processor, sender, redis, logger };
}

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: 'evt1',
    name: 'order.placed.v1',
    queueName: 'notifications',
    data: { eventId: 'evt1', aggregateId: 'order1', payload: { orderId: 'order1' } },
    attemptsMade: 1,
    opts: { attempts: 6 },
    ...overrides,
  }) as Job;

describe('NotificationsProcessor', () => {
  it('sends the email keyed by the job id, then marks the job sent', async () => {
    const { processor, sender, redis } = buildProcessor();

    await processor.process(job());

    expect(sender.send).toHaveBeenCalledWith('order.placed.v1', job().data, 'evt1');
    expect(redis.set).toHaveBeenCalledWith(`${SENT_MARKER_PREFIX}:evt1`, '1', 'EX', expect.any(Number));
    expect(sender.send.mock.invocationCallOrder[0]).toBeLessThan(redis.set.mock.invocationCallOrder[0]);
  });

  it('sends nothing for a job whose email already went out (retry, stalled run, event published twice)', async () => {
    const { processor, sender, redis } = buildProcessor(true);

    await processor.process(job());

    expect(redis.exists).toHaveBeenCalledWith(`${SENT_MARKER_PREFIX}:evt1`);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('leaves no marker when the send fails, so the queue retries the email', async () => {
    const { processor, sender, redis } = buildProcessor();
    sender.send.mockRejectedValue(new Error('Email not delivered: Order Confirmed | rate_limit_exceeded'));

    await expect(processor.process(job())).rejects.toThrow('rate_limit_exceeded');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('warns on an attempt with retries left and errors once they are spent, never logging job data', () => {
    const { processor, logger } = buildProcessor();
    const data = { to: 'kwame@gmail.com', resetToken: 'secret-token' };

    processor.onFailed(job({ name: 'email.password_reset.v1', data, attemptsMade: 2 }), new Error('quota'));
    processor.onFailed(job({ name: 'email.password_reset.v1', data, attemptsMade: 6 }), new Error('quota'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt: 2/6 | quota | will retry'),
      expect.any(String),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('attempt: 6/6 | quota | no attempts left; kept in the failed set'),
      undefined,
      'NotificationsProcessor',
    );
    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('kwame@gmail.com');
    expect(logged).not.toContain('secret-token');
  });
});
