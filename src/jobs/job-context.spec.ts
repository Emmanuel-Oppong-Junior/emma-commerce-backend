import { Job } from 'bullmq';
import { currentCorrelation, runWithCorrelation } from '../commons/correlation';
import { runJobInContext, withJobMeta } from './job-context';

const job = (data: unknown) => ({ id: 'job-1', queueName: 'notifications', name: 'email.welcome.v1', data }) as Job;

describe('withJobMeta', () => {
  it('adds the running request id to the job data', () => {
    const data = runWithCorrelation({ requestId: 'req-1' }, () => withJobMeta({ webhookEventId: 'evt-1' }));

    expect(data).toEqual({ webhookEventId: 'evt-1', meta: { requestId: 'req-1' } });
  });

  it('leaves the data unchanged outside a request', () => {
    expect(withJobMeta({ webhookEventId: 'evt-1' })).toEqual({ webhookEventId: 'evt-1' });
  });
});

describe('runJobInContext', () => {
  it('runs the job under the request id that queued it, with the job id and queue', async () => {
    const seen = await runJobInContext(job({ to: 'x', meta: { requestId: 'req-1' } }), async () =>
      currentCorrelation(),
    );

    expect(seen).toEqual({ requestId: 'req-1', jobId: 'job-1', queue: 'notifications' });
  });

  it.each([
    ['a scheduled job (no meta)', {}],
    ['a malformed request id', { meta: { requestId: 'bad id\n' } }],
    ['no data', undefined],
  ])('gives %s its own generated request id', async (_case, data) => {
    const seen = await runJobInContext(job(data), async () => currentCorrelation());

    expect(seen?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toMatchObject({ jobId: 'job-1', queue: 'notifications' });
  });

  it('returns the work result and propagates its failure', async () => {
    await expect(runJobInContext(job({}), async () => 'done')).resolves.toBe('done');
    await expect(
      runJobInContext(job({}), async () => {
        throw new Error('send failed');
      }),
    ).rejects.toThrow('send failed');
  });
});
