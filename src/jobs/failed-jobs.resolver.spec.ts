import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../iam/authorization/policy.decorators';
import { FailedJobsResolver } from './failed-jobs.resolver';
import { JobQueue } from './job-queues';

describe('FailedJobsResolver', () => {
  const service = { list: jest.fn(), retry: jest.fn() };
  const resolver = new FailedJobsResolver(service as never);
  const permissionsOf = (handler: unknown) =>
    new Reflector().getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler as () => void, FailedJobsResolver]);

  beforeEach(() => jest.clearAllMocks());

  it.each(['failedJobs', 'retryFailedJob'] as const)('restricts %s to jobs.manage (the Owner only)', (handler) => {
    expect(permissionsOf(FailedJobsResolver.prototype[handler])).toEqual(['jobs.manage']);
  });

  it('lists the queue for the acting super admin', async () => {
    service.list.mockResolvedValue([]);

    await resolver.failedJobs('super1', { queue: JobQueue.NOTIFICATIONS, first: 20 });

    expect(service.list).toHaveBeenCalledWith(JobQueue.NOTIFICATIONS, 20, 'super1');
  });

  it('retries the job for the acting super admin', async () => {
    await resolver.retryFailedJob('super1', { queue: JobQueue.WEBHOOKS, jobId: 'evt1' });

    expect(service.retry).toHaveBeenCalledWith(JobQueue.WEBHOOKS, 'evt1', 'super1');
  });
});
