import { setTimeout as sleep } from 'node:timers/promises';
import { currentCorrelation, resolveRequestId, runWithCorrelation } from './correlation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['abc-123', 'A1', 'a'.repeat(64), '0b6f1c2e-6a52-4b7f-9c1d-3f5e2a1b0c9d'])(
    'keeps a well-formed id %s',
    (id) => {
      expect(resolveRequestId(id)).toBe(id);
    },
  );

  it.each([
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
    ['a newline (log forging)', 'abc\n{"level":"error"}'],
    ['spaces', 'abc def'],
    ['other punctuation', 'abc_def'],
    ['a repeated header', ['abc', 'def']],
    ['no header', undefined],
  ])('replaces %s with a generated UUID', (_case, value) => {
    expect(resolveRequestId(value)).toMatch(UUID);
  });
});

describe('correlation context', () => {
  it('is undefined outside a request or job', () => {
    expect(currentCorrelation()).toBeUndefined();
  });

  it('follows async work started inside the context, and reads the user once the request is authenticated', async () => {
    const request: { user?: { id: string } } = {};
    const seen = await runWithCorrelation({ requestId: 'req-1', request }, async () => {
      const before = currentCorrelation();
      request.user = { id: 'user-1' };
      await sleep(1);
      return [before, currentCorrelation()];
    });

    expect(seen).toEqual([{ requestId: 'req-1' }, { requestId: 'req-1', userId: 'user-1' }]);
    expect(currentCorrelation()).toBeUndefined();
  });

  it('keeps concurrent requests apart', async () => {
    const read = (requestId: string, delayMs: number) =>
      runWithCorrelation({ requestId }, async () => {
        await sleep(delayMs);
        return currentCorrelation()?.requestId;
      });

    await expect(Promise.all([read('first', 5), read('second', 1)])).resolves.toEqual(['first', 'second']);
  });

  it('carries the job id and queue of a job', () => {
    expect(
      runWithCorrelation({ requestId: 'req-1', jobId: 'job-1', queue: 'notifications' }, currentCorrelation),
    ).toEqual({ requestId: 'req-1', jobId: 'job-1', queue: 'notifications' });
  });
});
