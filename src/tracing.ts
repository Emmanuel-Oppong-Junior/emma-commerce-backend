/**
 * OpenTelemetry tracing bootstrap.
 * Must be imported BEFORE any other application module to correctly instrument
 * Node.js built-ins and third-party libraries.
 *
 * Activate by setting OTEL_ENABLED=true in your environment.
 * Optional: set OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

if (process.env.OTEL_ENABLED === 'true') {
  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'franko-backend',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    }),
    spanProcessor: new BatchSpanProcessor(exporter),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on('SIGTERM', async () => {
    await sdk.shutdown();
  });
}
