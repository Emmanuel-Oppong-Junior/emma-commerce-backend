import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const reply = await this.redis.ping();
      if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return indicator.down({ error: message });
    }
  }
}
