/**
 * OpenTelemetry bootstrap (one NodeSDK for traces and metrics), started by src/instrument.ts before any other
 * application module so that Node.js built-ins and third-party libraries are instrumented.
 *
 * Traces: on with OTEL_ENABLED=true, exported over OTLP (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME).
 * Metrics: on unless METRICS_ENABLED=false, served for Prometheus by the exporter's own HTTP server on METRICS_PORT
 * (default 9464), never on the public API port.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export const DEFAULT_METRICS_PORT = 9464;

export interface Telemetry {
  sdk: NodeSDK;
  /** Resolves once /metrics is listening; rejects when METRICS_PORT cannot be bound. Undefined when metrics are off. */
  metricsServer?: Promise<void>;
}

export function startTelemetry(env: NodeJS.ProcessEnv): Telemetry | undefined {
  const tracing = env.OTEL_ENABLED === 'true';
  const metrics = env.METRICS_ENABLED !== 'false';
  if (!tracing && !metrics) return undefined;

  // All interfaces (the exporter defaults to localhost, which a scraper outside the container cannot reach). Started
  // explicitly below so a port clash fails startup instead of only reaching OpenTelemetry's silent diag log.
  const prometheus = metrics
    ? new PrometheusExporter({
        host: '0.0.0.0',
        port: Number(env.METRICS_PORT ?? DEFAULT_METRICS_PORT),
        preventServerStart: true,
      })
    : undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'emma-commerce-backend',
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '1.0.0',
    }),
    // An explicit empty list, because an omitted one makes the SDK add a default OTLP metrics exporter.
    metricReaders: prometheus ? [prometheus] : [],
    ...(tracing
      ? {
          traceExporter: new OTLPTraceExporter({
            url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
          }),
          instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
        }
      : // Metrics only: no tracer provider and no OTLP log exporter (both default on when omitted).
        { spanProcessors: [], logRecordProcessors: [] }),
  });

  sdk.start();
  return { sdk, metricsServer: prometheus?.startServer() };
}
