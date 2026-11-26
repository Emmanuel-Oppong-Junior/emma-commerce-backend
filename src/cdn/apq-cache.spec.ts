import { Redis } from 'ioredis';
import { APQ_TTL_SECONDS, RedisApqCache } from './apq-cache';

describe('RedisApqCache', () => {
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const cache = new RedisApqCache(redis as unknown as Redis);

  beforeEach(() => jest.resetAllMocks());

  it('stores a query under the app namespace with the given ttl', async () => {
    await cache.set('apq:abc', '{ products { id } }', { ttl: 300 });
    expect(redis.set).toHaveBeenCalledWith('graphql:apq:abc', '{ products { id } }', 'EX', 300);
  });

  it('never stores a query without expiry or longer than a day', async () => {
    await cache.set('apq:abc', 'q', { ttl: null });
    await cache.set('apq:abc', 'q');
    await cache.set('apq:abc', 'q', { ttl: APQ_TTL_SECONDS * 30 });
    expect(redis.set.mock.calls.map((call) => call[3])).toEqual([APQ_TTL_SECONDS, APQ_TTL_SECONDS, APQ_TTL_SECONDS]);
  });

  it('reads a stored query, and undefined for an unknown hash', async () => {
    redis.get.mockResolvedValueOnce('q').mockResolvedValueOnce(null);
    await expect(cache.get('apq:abc')).resolves.toBe('q');
    await expect(cache.get('apq:def')).resolves.toBeUndefined();
    expect(redis.get).toHaveBeenCalledWith('graphql:apq:abc');
  });

  it('deletes a stored query', async () => {
    redis.del.mockResolvedValueOnce(1);
    await expect(cache.delete('apq:abc')).resolves.toBe(true);
    expect(redis.del).toHaveBeenCalledWith('graphql:apq:abc');
  });
});
