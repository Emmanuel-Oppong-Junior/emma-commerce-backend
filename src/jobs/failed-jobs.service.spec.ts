import { ConflictException, NotFoundException } from '@nestjs/common';
import { FailedJobsService, sanitizeFailedReason } from './failed-jobs.service';
import { JobQueue } from './job-queues';

const failedJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt1',
  name: 'order.placed.v1',
  attemptsMade: 6,
  opts: { attempts: 6 },
  failedReason: 'Email not delivered: Order Confirmed | rate_limit_exceeded for kwame.asante@gmail.com',
  timestamp: Date.UTC(2026, 10, 20, 8, 0, 0),
  finishedOn: Date.UTC(2026, 10, 20, 8, 5, 0),
  data: { to: 'kwame.asante@gmail.com', resetToken: 'secret-token' },
  getState: jest.fn().mockResolvedValue('failed'),
  retry: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

function buildService() {
  const queue = () => ({ getFailed: jest.fn(), getJob: jest.fn() });
  const queues = { notifications: queue(), webhooks: queue(), maintenance: queue(), imports: queue() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new FailedJobsService(
    audit as never,
    queues.notifications as never,
    queues.webhooks as never,
    queues.maintenance as never,
    queues.imports as never,
  );
  return { service, queues, audit };
}

describe('sanitizeFailedReason', () => {
  it('masks email addresses and caps the length', () => {
    const reason = sanitizeFailedReason(`to ama@example.com.gh and <kofi@shop.test>: ${'x'.repeat(600)}`);

    expect(reason).not.toContain('ama@');
    expect(reason).not.toContain('kofi@');
    expect(reason.startsWith('to [email] and <[email]>: ')).toBe(true);
    expect(reason).toHaveLength(500);
  });

  it('returns an empty string for a job with no reason', () => {
    expect(sanitizeFailedReason(undefined)).toBe('');
  });
});

describe('FailedJobsService', () => {
  describe('list', () => {
    it("returns the queue's newest failed jobs without their data, with addresses masked, and audits the view", async () => {
      const { service, queues, audit } = buildService();
      queues.notifications.getFailed.mockResolvedValue([failedJob()]);

      const jobs = await service.list(JobQueue.NOTIFICATIONS, 20, 'super1');

      expect(queues.notifications.getFailed).toHaveBeenCalledWith(0, 19);
      expect(jobs).toEqual([
        {
          queue: JobQueue.NOTIFICATIONS,
          id: 'evt1',
          name: 'order.placed.v1',
          attemptsMade: 6,
          maxAttempts: 6,
          failedReason: 'Email not delivered: Order Confirmed | rate_limit_exceeded for [email]',
          createdAt: new Date('2026-11-20T08:00:00.000Z'),
          failedAt: new Date('2026-11-20T08:05:00.000Z'),
        },
      ]);
      expect(JSON.stringify(jobs)).not.toContain('secret-token');
      expect(audit.log).toHaveBeenCalledWith({
        entity: 'FailedJob',
        entityId: 'notifications',
        action: 'VIEW',
        userId: 'super1',
        details: { count: 1 },
      });
    });

    it('reads only the requested queue', async () => {
      const { service, queues } = buildService();
      queues.webhooks.getFailed.mockResolvedValue([]);

      await service.list(JobQueue.WEBHOOKS, 5, 'super1');

      expect(queues.webhooks.getFailed).toHaveBeenCalledWith(0, 4);
      expect(queues.notifications.getFailed).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('sends a failed job back with its attempts reset and audits the retry', async () => {
      const { service, queues, audit } = buildService();
      const job = failedJob();
      queues.notifications.getJob.mockResolvedValue(job);

      const result = await service.retry(JobQueue.NOTIFICATIONS, 'evt1', 'super1');

      expect(job.retry).toHaveBeenCalledWith('failed', { resetAttemptsMade: true });
      expect(result).toMatchObject({ id: 'evt1', attemptsMade: 6 });
      expect(audit.log).toHaveBeenCalledWith({
        entity: 'FailedJob',
        entityId: 'notifications:evt1',
        action: 'RETRY',
        userId: 'super1',
        details: { name: 'order.placed.v1', attemptsMade: 6 },
      });
    });

    it('rejects an unknown job with NOT_FOUND and audits nothing', async () => {
      const { service, queues, audit } = buildService();
      queues.webhooks.getJob.mockResolvedValue(undefined);

      await expect(service.retry(JobQueue.WEBHOOKS, 'missing', 'super1')).rejects.toThrow(NotFoundException);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses to retry a job that is not in the failed set', async () => {
      const { service, queues, audit } = buildService();
      const job = failedJob({ getState: jest.fn().mockResolvedValue('completed') });
      queues.maintenance.getJob.mockResolvedValue(job);

      await expect(service.retry(JobQueue.MAINTENANCE, 'evt1', 'super1')).rejects.toThrow(
        new ConflictException('Job "evt1" is completed; only failed jobs can be retried'),
      );
      expect(job.retry).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});
