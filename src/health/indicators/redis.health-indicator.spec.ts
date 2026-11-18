import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health-indicator';

function buildIndicator(redisHost: string | undefined, cache: { set: jest.Mock; get: jest.Mock }) {
  const config = { get: jest.fn().mockReturnValue(redisHost) };
  return new RedisHealthIndicator(cache as never, config as never, new HealthIndicatorService());
}

describe('RedisHealthIndicator', () => {
  it('reports up without probing the cache when REDIS_HOST is not configured', async () => {
    const cache = { set: jest.fn(), get: jest.fn() };

    await expect(buildIndicator(undefined, cache).isHealthy('redis')).resolves.toMatchObject({
      redis: { status: 'up' },
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('reports up when the configured Redis answers the probe', async () => {
    const cache = { set: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(1) };

    await expect(buildIndicator('redis.internal', cache).isHealthy('redis')).resolves.toEqual({
      redis: { status: 'up' },
    });
  });

  it('reports down when the configured Redis is unreachable', async () => {
    const cache = { set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), get: jest.fn() };

    await expect(buildIndicator('redis.internal', cache).isHealthy('redis')).resolves.toEqual({
      redis: { status: 'down', error: 'ECONNREFUSED' },
    });
  });
});
