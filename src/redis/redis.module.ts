import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, RedisOptions } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

// A request-path command (throttle check, health probe) fails after this many reconnect attempts instead of hanging.
const COMMAND_RETRIES = 2;

/** Connection settings for every Redis client the process opens: the shared client and BullMQ's connections. */
export function redisConnectionOptions(config: ConfigService): RedisOptions {
  return {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: config.getOrThrow<number>('REDIS_PORT'),
    password: config.get<string>('REDIS_PASSWORD'),
    db: config.getOrThrow<number>('REDIS_DB'),
  };
}

async function connectRedis(config: ConfigService): Promise<Redis> {
  const logger = new Logger('Redis');
  const client = new Redis({
    ...redisConnectionOptions(config),
    maxRetriesPerRequest: COMMAND_RETRIES,
    lazyConnect: true,
  });
  client.on('error', (error: Error) => logger.error(`Redis connection error: ${error.message}`));
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Redis at ${client.options.host}:${client.options.port}: ${reason}`);
  }
  return client;
}

/** The process's shared ioredis client (throttler storage, health probe), connected at startup and closed on shutdown. */
@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, inject: [ConfigService], useFactory: connectRedis }],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit();
  }
}
