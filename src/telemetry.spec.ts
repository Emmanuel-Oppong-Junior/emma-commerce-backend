import { readFileSync } from 'fs';
import { join } from 'path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { metrics } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { startTelemetry } from './telemetry';
import { freePort, scrapeMetrics } from '../test/helpers/metrics.helper';

describe('startTelemetry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    metrics.disable();
  });

  it.each([
    { METRICS_ENABLED: 'false' },
    { OTEL_ENABLED: 'false', METRICS_ENABLED: 'false' },
    { OTEL_ENABLED: 'TRUE', METRICS_ENABLED: 'false' },
  ])('does nothing when env is %j', (env) => {
    const start = jest.spyOn(NodeSDK.prototype, 'start');

    expect(startTelemetry(env)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the SDK when OTEL_ENABLED is "true"', () => {
    const start = jest.spyOn(NodeSDK.prototype, 'start').mockImplementation(() => undefined);

    const telemetry = startTelemetry({ OTEL_ENABLED: 'true', METRICS_ENABLED: 'false' });

    expect(telemetry?.sdk).toBeInstanceOf(NodeSDK);
    expect(telemetry?.metricsServer).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('serves Prometheus metrics on METRICS_PORT by default (metrics are on unless METRICS_ENABLED=false)', async () => {
    const port = await freePort();
    const telemetry = startTelemetry({ METRICS_PORT: String(port) });
    try {
      await telemetry?.metricsServer;
      metrics.getMeter('test').createCounter('telemetry_spec_probe').add(1);

      await expect(scrapeMetrics(port)).resolves.toMatch(/^telemetry_spec_probe_total\{[^}]*\} 1$/m);
    } finally {
      await telemetry?.sdk.shutdown();
    }
  });

  it('fails startup when METRICS_PORT is already taken', async () => {
    const taken = createServer().listen(0, '0.0.0.0');
    await once(taken, 'listening');
    const port = (taken.address() as { port: number }).port;
    const telemetry = startTelemetry({ METRICS_PORT: String(port) });
    try {
      await expect(telemetry?.metricsServer).rejects.toThrow('EADDRINUSE');
    } finally {
      await telemetry?.sdk.shutdown();
      taken.close();
    }
  });
});

describe('main.ts', () => {
  // Auto-instrumentation only patches modules (http, express, pg) required after the SDK starts.
  it('imports tracing (through src/instrument.ts) before anything else', () => {
    const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const firstImport = source.split('\n').find((line) => line.startsWith('import '));

    expect(firstImport).toBe("import { telemetry } from './instrument';");
  });

  it('starts Sentry, then tracing, from src/instrument.ts, which loads neither Nest, Express nor Prisma', () => {
    const source = readFileSync(join(__dirname, 'instrument.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));

    expect(imports).toEqual([
      "import { initSentry } from './observability/sentry';",
      "import { startTelemetry } from './telemetry';",
    ]);
    expect(source.indexOf('initSentry(process.env)')).toBeLessThan(source.indexOf('startTelemetry(process.env)'));
  });
});
