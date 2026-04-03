import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { CloudinaryHealthIndicator } from './indicators/cloudinary.health-indicator';

@Module({
  imports: [TerminusModule, PrismaModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, CloudinaryHealthIndicator],
})
export class HealthModule {}
