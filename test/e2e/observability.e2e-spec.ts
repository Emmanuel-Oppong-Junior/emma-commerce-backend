import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { setTimeout as sleep } from 'node:timers/promises';
import * as request from 'supertest';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { freePort, samplesOf, scrapeMetrics } from '../helpers/metrics.helper';
import { startTelemetry, Telemetry } from '../../src/telemetry';
import { JobQueue } from '../../src/jobs/job-queues';
import { PAYSTACK_WEBHOOK_JOB } from '../../src/payment/payment-webhook.service';

describe('Observability (e2e)', () => {
  describe('request id', () => {
    let app: INestApplication;

    beforeAll(async () => {
      ({ app } = await createTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it('echoes a well-formed client X-Request-ID on REST and GraphQL responses', async () => {
      await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-ID', 'e2e-request-1')
        .expect(200)
        .expect('X-Request-ID', 'e2e-request-1');
      await request(app.getHttpServer())
        .post('/graphql')
        .set('X-Request-ID', 'e2e-request-2')
        .send({ query: '{ __typename }' })
        .expect(200)
        .expect('X-Request-ID', 'e2e-request-2');
    });

    it('replaces a malformed or missing id with a generated one', async () => {
      const malformed = await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-ID', 'not valid; id')
        .expect(200);
      const missing = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(missing.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // The API and the worker share this process (and so one /metrics); in production each serves its own METRICS_PORT.
  describe('Prometheus metrics on METRICS_PORT', () => {
    let port: number;
    let telemetry: Telemetry | undefined;
    let app: INestApplication;
    let worker: INestApplicationContext;

    beforeAll(async () => {
      port = await freePort();
      // Before the apps are built, so their AppMetrics record through the Prometheus-backed meter.
      telemetry = startTelemetry({ METRICS_PORT: String(port) });
      await telemetry?.metricsServer;
      ({ app } = await createTestApp());
      worker = await createTestWorker();
      await clearQueues(worker);
    });

    afterAll(async () => {
      await clearQueues(worker);
      await worker.close();
      await app.close();
      await telemetry?.sdk.shutdown();
      metrics.disable();
    });

    it('serves RED, job, queue and outbox metrics after a request and a job, without ids or variables', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      await request(app.getHttpServer()).get('/no-such-route/123').expect(404);
      await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: 'query ObservabilityProbe { __typename }' })
        .expect(200);
      const queue = getQueue(worker, JobQueue.WEBHOOKS);
      const job = await queue.add(PAYSTACK_WEBHOOK_JOB, { webhookEventId: 'evt-missing' });
      const deadline = Date.now() + 15_000;
      while ((await job.getState()) !== 'completed') {
        if (Date.now() > deadline) throw new Error(`Job did not complete: ${await job.getState()}`);
        await sleep(100);
      }

      const text = await scrapeMetrics(port);

      const sample = (labels: Record<string, string>) => ({
        labels: expect.objectContaining(labels),
        value: expect.any(Number),
      });
      expect(samplesOf(text, 'http_request_duration_seconds_count')).toEqual(
        expect.arrayContaining([
          sample({ method: 'GET', route: '/health/live', status_class: '2xx' }),
          sample({ method: 'GET', route: 'unmatched', status_class: '4xx' }),
          sample({ method: 'POST', route: '/graphql', status_class: '2xx' }),
        ]),
      );
      expect(samplesOf(text, 'api_errors_total')).toContainEqual(sample({ transport: 'http', code: 'NOT_FOUND' }));
      expect(samplesOf(text, 'graphql_operation_duration_seconds_count')).toContainEqual(
        sample({ operation_name: 'ObservabilityProbe', operation_type: 'query', outcome: 'ok' }),
      );
      expect(samplesOf(text, 'job_duration_seconds_count')).toContainEqual(
        sample({ queue: 'webhooks', name: PAYSTACK_WEBHOOK_JOB, outcome: 'completed' }),
      );
      expect(samplesOf(text, 'queue_jobs')).toContainEqual({
        labels: expect.objectContaining({ queue: 'webhooks', state: 'failed' }),
        value: 0,
      });
      expect(samplesOf(text, 'outbox_unpublished_events')).toHaveLength(1);
      expect(samplesOf(text, 'outbox_oldest_unpublished_age_seconds')).toHaveLength(1);
      expect(text).not.toContain('no-such-route/123');
      expect(text).not.toContain('evt-missing');
    });
  });
});
