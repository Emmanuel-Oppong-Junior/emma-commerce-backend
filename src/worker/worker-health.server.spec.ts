import { WorkerHealthServer } from './worker-health.server';

function buildServer({ database = jest.fn().mockResolvedValue([1]), ping = jest.fn().mockResolvedValue('PONG') } = {}) {
  return new WorkerHealthServer({} as never, { $queryRaw: database } as never, { ping } as never, {} as never);
}

describe('WorkerHealthServer.respond', () => {
  it('answers liveness without touching dependencies', async () => {
    const database = jest.fn();
    const ping = jest.fn();

    await expect(buildServer({ database, ping }).respond('GET', '/health/live')).resolves.toEqual({
      status: 200,
      body: { status: 'ok', role: 'worker' },
    });
    expect(database).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('is ready when Postgres and Redis both answer', async () => {
    await expect(buildServer().respond('GET', '/health/ready')).resolves.toEqual({
      status: 200,
      body: { status: 'ok', info: { database: { status: 'up' }, redis: { status: 'up' } } },
    });
  });

  it('is not ready (503) when Redis is down', async () => {
    const ping = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(buildServer({ ping }).respond('GET', '/health/ready')).resolves.toEqual({
      status: 503,
      body: {
        status: 'error',
        info: { database: { status: 'up' }, redis: { status: 'down', error: 'ECONNREFUSED' } },
      },
    });
  });

  it.each([
    ['POST', '/health/live', 405],
    ['GET', '/graphql', 404],
  ])('refuses %s %s with %i', async (method, url, status) => {
    await expect(buildServer().respond(method, url)).resolves.toMatchObject({ status });
  });
});
