import { RedisThrottlerStorage } from './redis-throttler.storage';

function storageReturning(reply: [number, number, number, number]) {
  const evalScript = jest.fn().mockResolvedValue(reply);
  return { storage: new RedisThrottlerStorage({ eval: evalScript } as never), evalScript };
}

describe('RedisThrottlerStorage', () => {
  it('runs one script over the hit and block keys of the throttler and key, passing durations in ms', async () => {
    const { storage, evalScript } = storageReturning([1, 60000, 0, 0]);

    await storage.increment('abc123', 60000, 5, 30000, 'auth');

    expect(evalScript).toHaveBeenCalledTimes(1);
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      2,
      'throttle:auth:abc123:hits',
      'throttle:auth:abc123:blocked',
      60000,
      5,
      30000,
    );
  });

  it('reports an allowed hit with the window remaining in whole seconds and no block', async () => {
    const { storage } = storageReturning([3, 41_200, 0, 0]);

    await expect(storage.increment('k', 60000, 5, 60000, 'global')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('reports a blocked hit with the block remaining in whole seconds', async () => {
    const { storage } = storageReturning([6, 0, 1, 29_001]);

    await expect(storage.increment('k', 60000, 5, 30000, 'auth')).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it('propagates a Redis failure instead of letting the request through unthrottled', async () => {
    const storage = new RedisThrottlerStorage({
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);

    await expect(storage.increment('k', 60000, 5, 60000, 'global')).rejects.toThrow('ECONNREFUSED');
  });
});
