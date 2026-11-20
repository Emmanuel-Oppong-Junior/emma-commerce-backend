import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorFunction, PrismaHealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { CloudinaryHealthIndicator } from './indicators/cloudinary.health-indicator';

@Auth(AuthType.None)
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly cloudinaryHealth: CloudinaryHealthIndicator,
  ) {}

  // Full dependency report for dashboards and alerts. Cloudinary is checked here only: an image-CDN
  // outage must not take replicas out of rotation via /health/ready.
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([...this.readinessChecks(), () => this.cloudinaryHealth.isHealthy('cloudinary')]);
  }

  @Get('live')
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check(this.readinessChecks());
  }

  private readinessChecks(): HealthIndicatorFunction[] {
    return [() => this.prismaHealth.pingCheck('database', this.prisma), () => this.redisHealth.isHealthy('redis')];
  }
}
