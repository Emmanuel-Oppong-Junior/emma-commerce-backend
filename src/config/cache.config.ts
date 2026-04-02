import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createKeyv } from '@keyv/redis';

/**
 * Async cache configuration.
 * Uses Redis when REDIS_HOST is set; falls back to in-memory cache for local dev.
 */
export const cacheConfig: CacheModuleAsyncOptions = {
  isGlobal: true,
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => {
    const redisHost = configService.get<string>('REDIS_HOST');
    const redisPort = configService.get<number>('REDIS_PORT') ?? 6379;
    const redisPassword = configService.get<string>('REDIS_PASSWORD');

    if (redisHost) {
      const redisUrl = redisPassword
        ? `redis://:${redisPassword}@${redisHost}:${redisPort}`
        : `redis://${redisHost}:${redisPort}`;
      return {
        stores: [createKeyv(redisUrl)],
        ttl: 60 * 5 * 1000, // 5 minutes default
      };
    }

    // In-memory fallback (development)
    return {
      ttl: 60 * 5 * 1000,
    };
  },
  inject: [ConfigService],
};
