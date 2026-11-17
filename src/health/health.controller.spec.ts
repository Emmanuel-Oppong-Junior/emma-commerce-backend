import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckError, PrismaHealthIndicator, TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { CloudinaryHealthIndicator } from './indicators/cloudinary.health-indicator';

const up = (key: string) => Promise.resolve({ [key]: { status: 'up' } });
const down = (key: string) =>
  Promise.reject(new HealthCheckError(`${key} failed`, { [key]: { status: 'down', error: 'unreachable' } }));

describe('HealthController', () => {
  const prismaHealth = { pingCheck: jest.fn() };
  const redisHealth = { isHealthy: jest.fn() };
  const cloudinaryHealth = { isHealthy: jest.fn() };
  let controller: HealthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaHealth.pingCheck.mockImplementation((key: string) => up(key));
    redisHealth.isHealthy.mockImplementation((key: string) => up(key));
    cloudinaryHealth.isHealthy.mockImplementation((key: string) => up(key));

    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: RedisHealthIndicator, useValue: redisHealth },
        { provide: CloudinaryHealthIndicator, useValue: cloudinaryHealth },
      ],
    })
      .overrideProvider(PrismaHealthIndicator)
      .useValue(prismaHealth)
      .compile();
    controller = moduleRef.get(HealthController);
  });

  describe('GET /health/ready', () => {
    it('is ready when the database and Redis are up', async () => {
      const result = await controller.readiness();
      expect(result.status).toBe('ok');
      expect(Object.keys(result.details)).toEqual(['database', 'redis']);
    });

    it('stays ready when Cloudinary is down and never probes it', async () => {
      cloudinaryHealth.isHealthy.mockImplementation((key: string) => down(key));

      await expect(controller.readiness()).resolves.toMatchObject({ status: 'ok' });
      expect(cloudinaryHealth.isHealthy).not.toHaveBeenCalled();
    });

    it('is not ready (503) when the database is down', async () => {
      prismaHealth.pingCheck.mockImplementation((key: string) => down(key));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('is not ready (503) when configured Redis is down', async () => {
      redisHealth.isHealthy.mockImplementation((key: string) => down(key));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('GET /health', () => {
    it('reports the database, Redis and Cloudinary', async () => {
      const result = await controller.check();
      expect(result.status).toBe('ok');
      expect(Object.keys(result.details)).toEqual(['database', 'redis', 'cloudinary']);
    });

    it('reports a Cloudinary outage as 503 for dashboards and alerts', async () => {
      cloudinaryHealth.isHealthy.mockImplementation((key: string) => down(key));
      await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('GET /health/live', () => {
    it('answers ok without checking any dependency', () => {
      expect(controller.liveness()).toMatchObject({ status: 'ok' });
      expect(prismaHealth.pingCheck).not.toHaveBeenCalled();
    });
  });
});
