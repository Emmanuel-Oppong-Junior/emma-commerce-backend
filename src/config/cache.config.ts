import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createKeyv } from '@keyv/redis';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** The cache lives in Redis in every environment, so all instances share it (ADR-0011). */
export const cacheConfig: CacheModuleAsyncOptions = {
  isGlobal: true,
  imports: [ConfigModule],
  useFactory: (configService: ConfigService) => ({
    stores: [
      createKeyv({
        socket: {
          host: configService.getOrThrow<string>('REDIS_HOST'),
          port: configService.getOrThrow<number>('REDIS_PORT'),
        },
        password: configService.get<string>('REDIS_PASSWORD'),
        database: configService.getOrThrow<number>('REDIS_DB'),
      }),
    ],
    ttl: DEFAULT_TTL_MS,
  }),
  inject: [ConfigService],
};
