import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';

const REDIS_PROBE_KEY = '__health_probe__';
const REDIS_PROBE_TTL_MS = 5000;

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const redisHost = this.configService.get<string>('REDIS_HOST');
    if (!redisHost) {
      return this.getStatus(key, true, { message: 'Redis not configured; using in-memory cache' });
    }

    try {
      await this.cacheManager.set(REDIS_PROBE_KEY, 1, REDIS_PROBE_TTL_MS);
      const value = await this.cacheManager.get<number>(REDIS_PROBE_KEY);
      if (value !== 1) throw new Error('Cache probe returned unexpected value');
      return this.getStatus(key, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HealthCheckError('Redis health check failed', this.getStatus(key, false, { error: message }));
    }
  }
}
