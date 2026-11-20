import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health-indicator';

function buildIndicator(ping: jest.Mock) {
  return new RedisHealthIndicator({ ping } as never, new HealthIndicatorService());
}

describe('RedisHealthIndicator', () => {
  it('reports up when Redis answers PING', async () => {
    const ping = jest.fn().mockResolvedValue('PONG');

    await expect(buildIndicator(ping).isHealthy('redis')).resolves.toEqual({ redis: { status: 'up' } });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('reports down when Redis is unreachable', async () => {
    const ping = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(buildIndicator(ping).isHealthy('redis')).resolves.toEqual({
      redis: { status: 'down', error: 'ECONNREFUSED' },
    });
  });

  it('reports down on an unexpected PING reply', async () => {
    const ping = jest.fn().mockResolvedValue('LOADING');

    await expect(buildIndicator(ping).isHealthy('redis')).resolves.toEqual({
      redis: { status: 'down', error: 'Unexpected PING reply: LOADING' },
    });
  });
});
