import { Global, Module } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { AppMetrics, METER, METER_NAME } from './metrics';

/** Metrics for both roles. The meter is a no-op until src/telemetry.ts registers the Prometheus-backed provider. */
@Global()
@Module({
  providers: [{ provide: METER, useFactory: () => metrics.getMeter(METER_NAME) }, AppMetrics],
  exports: [METER, AppMetrics],
})
export class ObservabilityModule {}
