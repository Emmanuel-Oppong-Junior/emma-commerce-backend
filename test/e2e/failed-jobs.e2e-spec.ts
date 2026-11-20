import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmailService } from '../../src/notifications/email/email.service';
import { JobQueue } from '../../src/jobs/job-queues';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin } from '../helpers/auth.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';

const FAILED_JOBS = `query ($queue: JobQueue!) {
  failedJobs(queue: $queue) { queue id name attemptsMade maxAttempts failedReason createdAt failedAt }
}`;
const RETRY = `mutation ($queue: JobQueue!, $jobId: ID!) {
  retryFailedJob(queue: $queue, jobId: $jobId) { id name attemptsMade }
}`;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

describe('Failed background jobs (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let superAdminToken: string;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await clearQueues(app);
    worker = await createTestWorker();
    await resetDb(prisma);
    await seedMinimal(prisma);
    superAdminToken = await signInSuperAdmin(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await clearQueues(app);
    await worker.close();
    await resetDb(prisma);
    await app.close();
  });

  it('lists a job that spent its attempts, without PII, and runs it again on retry', async () => {
    const sends = jest
      .spyOn(worker.get(EmailService), 'sendWelcomeEmail')
      .mockRejectedValueOnce(new Error('Email not delivered: Welcome | mailbox kwame.asante@gmail.com is full'))
      .mockResolvedValue();
    const queue = getQueue(app, JobQueue.NOTIFICATIONS);
    const job = await queue.add(
      'email.welcome.v1',
      { to: 'kwame.asante@gmail.com', name: 'Kwame' },
      { attempts: 1, removeOnComplete: false },
    );
    await waitUntil(async () => (await job.getState()) === 'failed');

    const listed = await gqlRequest(app, FAILED_JOBS, { queue: 'NOTIFICATIONS' }, superAdminToken).expect(200);

    expect(listed.body.errors).toBeUndefined();
    expect(listed.body.data.failedJobs).toEqual([
      expect.objectContaining({
        queue: 'NOTIFICATIONS',
        id: job.id,
        name: 'email.welcome.v1',
        attemptsMade: 1,
        maxAttempts: 1,
        failedReason: 'Email not delivered: Welcome | mailbox [email] is full',
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('kwame.asante');

    const retried = await gqlRequest(app, RETRY, { queue: 'NOTIFICATIONS', jobId: job.id }, superAdminToken).expect(
      200,
    );
    expect(retried.body.data.retryFailedJob).toEqual({ id: job.id, name: 'email.welcome.v1', attemptsMade: 1 });

    await waitUntil(async () => (await (await queue.getJob(job.id!))!.getState()) === 'completed');
    expect(sends).toHaveBeenCalledTimes(2);
    const audits = await prisma.auditLog.findMany({ where: { entity: 'FailedJob' }, orderBy: { createdAt: 'asc' } });
    expect(audits).toEqual([
      expect.objectContaining({ action: 'VIEW', entityId: 'notifications', userId: 'seed_super_admin' }),
      expect.objectContaining({ action: 'RETRY', entityId: `notifications:${job.id}`, userId: 'seed_super_admin' }),
    ]);
  });

  it('refuses to retry a job that is not failed', async () => {
    const res = await gqlRequest(app, RETRY, { queue: 'WEBHOOKS', jobId: 'no-such-job' }, superAdminToken).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it.each([
    ['an admin', () => adminToken, 'FORBIDDEN'],
    ['an anonymous caller', () => undefined, 'UNAUTHENTICATED'],
  ])('refuses the failed-job list and retry to %s', async (_label, token, code) => {
    const list = await gqlRequest(app, FAILED_JOBS, { queue: 'NOTIFICATIONS' }, token()).expect(200);
    const retry = await gqlRequest(app, RETRY, { queue: 'NOTIFICATIONS', jobId: 'x' }, token()).expect(200);

    expect(list.body.errors[0].extensions.code).toBe(code);
    expect(retry.body.errors[0].extensions.code).toBe(code);
  });
});
