/**
 * OpenTelemetry tracing bootstrap, started by src/instrument.ts before any other application module so that
 * Node.js built-ins and third-party libraries are instrumented.
 *
 * Activate by setting OTEL_ENABLED=true in your environment.
 * Optional: set OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export function startTracing(env: NodeJS.ProcessEnv): NodeSDK | undefined {
  if (env.OTEL_ENABLED !== 'true') return undefined;

  const exporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'emma-commerce-backend',
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '1.0.0',
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  return sdk;
}
