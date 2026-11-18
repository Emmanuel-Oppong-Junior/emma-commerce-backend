import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';

const REDIS_PROBE_KEY = '__health_probe__';
const REDIS_PROBE_TTL_MS = 5000;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const redisHost = this.configService.get<string>('REDIS_HOST');
    if (!redisHost) {
      return indicator.up({ message: 'Redis not configured; using in-memory cache' });
    }

    try {
      await this.cacheManager.set(REDIS_PROBE_KEY, 1, REDIS_PROBE_TTL_MS);
      const value = await this.cacheManager.get<number>(REDIS_PROBE_KEY);
      if (value !== 1) throw new Error('Cache probe returned unexpected value');
      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return indicator.down({ error: message });
    }
  }
}
