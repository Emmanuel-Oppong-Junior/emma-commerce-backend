import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';

const CONTEXT = 'WorkerHealth';

/**
 * The worker serves no API, only GET /health/live (process up) and GET /health/ready (Postgres and Redis answer) on
 * PORT, so the image's HEALTHCHECK and orchestrator probes work for both roles.
 */
@Injectable()
export class WorkerHealthServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const port = this.config.getOrThrow<number>('PORT');
    this.server = createServer((req, res) => {
      void this.respond(req.method, req.url).then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    this.server.listen(port);
    await once(this.server, 'listening');
    this.logger.log(`Worker health endpoints listening on port ${port}`, CONTEXT);
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.server) return;
    this.server.close();
    await once(this.server, 'close');
  }

  async respond(method: string | undefined, url: string | undefined): Promise<{ status: number; body: object }> {
    if (method !== 'GET') return { status: 405, body: { status: 'error', error: 'Method not allowed' } };
    if (url === '/health/live') return { status: 200, body: { status: 'ok', role: 'worker' } };
    if (url !== '/health/ready') return { status: 404, body: { status: 'error', error: 'Not found' } };

    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() => this.redis.ping()),
    ]);
    const healthy = database.status === 'up' && redis.status === 'up';
    return { status: healthy ? 200 : 503, body: { status: healthy ? 'ok' : 'error', info: { database, redis } } };
  }

  private async probe(check: () => Promise<unknown>): Promise<{ status: 'up' | 'down'; error?: string }> {
    try {
      await check();
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
