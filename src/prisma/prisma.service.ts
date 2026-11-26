import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    // JIT compiles the large catalogue statements (facets, search pages) on every execution: 1-2 s each instead of
    // under 300 ms, measured in the P9-L load test. Behind PgBouncer this startup option needs ignore_startup_parameters.
    super({
      adapter: new PrismaPg({ connectionString: config.getOrThrow<string>('DATABASE_URL'), options: '-c jit=off' }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
