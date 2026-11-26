import type { PersistedQueryOptions } from '@apollo/server';
import { Redis } from 'ioredis';

type KeyValueCache = NonNullable<PersistedQueryOptions['cache']>;

/** Apollo prefixes the keys itself (`apq:<sha256>`); this namespaces them among the app's other Redis keys. */
export const APQ_KEY_PREFIX = 'graphql:';
/** A registered query lives a day; a client whose hash expired gets PersistedQueryNotFound and re-sends the query. */
export const APQ_TTL_SECONDS = 24 * 60 * 60;

/**
 * Automatic persisted queries shared by every API instance (Apollo's default store is per process). Entries always
 * expire, so the store stays bounded however many distinct queries clients register.
 */
export class RedisApqCache implements KeyValueCache {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.redis.get(APQ_KEY_PREFIX + key)) ?? undefined;
  }

  async set(key: string, value: string, options?: { ttl?: number | null }): Promise<void> {
    const ttl = options?.ttl ? Math.min(options.ttl, APQ_TTL_SECONDS) : APQ_TTL_SECONDS;
    await this.redis.set(APQ_KEY_PREFIX + key, value, 'EX', ttl);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(APQ_KEY_PREFIX + key)) > 0;
  }
}

export function persistedQueries(redis: Redis): PersistedQueryOptions {
  return { cache: new RedisApqCache(redis), ttl: APQ_TTL_SECONDS };
}
