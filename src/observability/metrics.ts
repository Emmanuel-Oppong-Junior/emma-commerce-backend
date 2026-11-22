import { Inject, Injectable } from '@nestjs/common';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { Job } from 'bullmq';
import { errorCodeForStatus } from '../commons/filters/error-classification';

/** The OpenTelemetry Meter the app records with (the global one, which src/telemetry.ts wires to Prometheus). */
export const METER = Symbol('METER');
export const METER_NAME = 'emma-commerce';

export const GRAPHQL_PATH = '/graphql';
// Operation names come from clients, so only this many distinct names get their own series; the rest are "other".
export const MAX_OPERATION_NAMES = 100;
const OPERATION_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]{0,63}$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type WebhookFailureReason = 'invalid_signature' | 'settlement_failed' | 'dispute_failed';

export type VelocityCheckStage = 'screen' | 'record';

export interface HttpRequestSample {
  method: string;
  route: string;
  status: number;
  seconds: number;
}

export interface GraphqlOperationSample {
  /** Undefined when the request never resolved to an operation (parse or validation failure). */
  operation?: { name: string | null | undefined; type: string };
  errorCodes: string[];
  seconds: number;
}

/**
 * The service's RED and job metrics. Labels are bounded: route templates (never raw paths), status classes, error
 * codes, queue and job names from code, and a capped set of GraphQL operation names. Never ids or variable values.
 */
@Injectable()
export class AppMetrics {
  private readonly httpDuration: Histogram;
  private readonly graphqlDuration: Histogram;
  private readonly errors: Counter;
  private readonly jobDuration: Histogram;
  private readonly jobFailures: Counter;
  private readonly webhookFailures: Counter;
  private readonly reconciliationMismatches: Counter;
  private readonly stockMismatches: Counter;
  private readonly velocityHits: Counter;
  private readonly velocityErrors: Counter;
  private readonly codGateRefusals: Counter;
  private readonly codRemittanceDiscrepancies: Counter;
  private readonly operationNames = new Set<string>();

  constructor(@Inject(METER) meter: Meter) {
    const advice = { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS };
    this.httpDuration = meter.createHistogram('http_request_duration_seconds', {
      description: 'HTTP request duration by method, route template and status class',
      unit: 's',
      advice,
    });
    this.graphqlDuration = meter.createHistogram('graphql_operation_duration_seconds', {
      description: 'GraphQL operation duration by operation name and type, and outcome (ok or the first error code)',
      unit: 's',
      advice,
    });
    this.errors = meter.createCounter('api_errors', {
      description: 'Errors returned to clients by transport and error code',
    });
    this.jobDuration = meter.createHistogram('job_duration_seconds', {
      description: 'Background job processing time by queue, job name and outcome',
      unit: 's',
      advice,
    });
    this.jobFailures = meter.createCounter('job_failures', {
      description: 'Failed job attempts by queue and job name (retried or final)',
    });
    this.webhookFailures = meter.createCounter('webhook_processing_failures', {
      description: 'Payment webhook deliveries rejected or not settled, by reason',
    });
    this.reconciliationMismatches = meter.createCounter('payment_reconciliation_mismatches', {
      description: 'Differences found by the daily Paystack reconciliation, by kind',
    });
    this.stockMismatches = meter.createCounter('stock_reconciliation_mismatches', {
      description:
        'Stock levels the nightly ledger reconciliation found out of line with movements or reservations, by kind',
    });
    this.velocityHits = meter.createCounter('velocity_limit_hits', {
      description:
        'Velocity rules found above a limit, by rule and level (SOFT flags the order, HARD refuses or flags)',
    });
    this.velocityErrors = meter.createCounter('velocity_check_errors', {
      description: 'Velocity checks skipped (fail-open) or events not counted because Redis failed, by stage',
    });
    this.codGateRefusals = meter.createCounter('cod_gate_refusals', {
      description: 'Cash-on-delivery orders refused at createOrder, by the gate that refused them',
    });
    this.codRemittanceDiscrepancies = meter.createCounter('cod_remittance_discrepancies', {
      description: 'Cash-on-delivery remittances that did not match their collections, by kind (SHORT or OVER)',
    });
  }

  recordHttpRequest({ method, route, status, seconds }: HttpRequestSample): void {
    const upper = method.toUpperCase();
    this.httpDuration.record(seconds, {
      method: HTTP_METHODS.has(upper) ? upper : 'OTHER',
      route,
      status_class: `${Math.floor(status / 100)}xx`,
    });
    // GraphQL answers its errors itself (mostly with HTTP 200); the GraphQL plugin counts those by code.
    if (status >= 400 && route !== GRAPHQL_PATH) {
      this.errors.add(1, { transport: 'http', code: errorCodeForStatus(status) });
    }
  }

  recordGraphqlOperation({ operation, errorCodes, seconds }: GraphqlOperationSample): void {
    this.graphqlDuration.record(seconds, {
      operation_name: operation ? this.boundedOperationName(operation.name) : 'invalid',
      operation_type: operation?.type ?? 'unknown',
      outcome: errorCodes[0] ?? 'ok',
    });
    for (const code of errorCodes) this.errors.add(1, { transport: 'graphql', code });
  }

  /** Runs one job attempt, timing it and counting a failure; the failure is rethrown for BullMQ to retry. */
  async observeJob<T>(job: Job, work: () => Promise<T>): Promise<T> {
    const labels = { queue: job.queueName, name: job.name };
    const start = performance.now();
    try {
      const result = await work();
      this.jobDuration.record(secondsSince(start), { ...labels, outcome: 'completed' });
      return result;
    } catch (error) {
      this.jobDuration.record(secondsSince(start), { ...labels, outcome: 'failed' });
      this.jobFailures.add(1, labels);
      throw error;
    }
  }

  recordWebhookFailure(reason: WebhookFailureReason): void {
    this.webhookFailures.add(1, { provider: 'paystack', reason });
  }

  recordReconciliationMismatches(countsByKind: Record<string, number>): void {
    for (const [kind, count] of Object.entries(countsByKind)) {
      if (count > 0) this.reconciliationMismatches.add(count, { kind });
    }
  }

  recordStockMismatches(countsByKind: Record<string, number>): void {
    for (const [kind, count] of Object.entries(countsByKind)) {
      if (count > 0) this.stockMismatches.add(count, { kind });
    }
  }

  /** `rule` and `level` are enum values from code, so the series stay bounded. */
  recordVelocityLimitHit(rule: string, level: string): void {
    this.velocityHits.add(1, { rule, level });
  }

  recordVelocityCheckError(stage: VelocityCheckStage): void {
    this.velocityErrors.add(1, { stage });
  }

  /** `gate` is a CodUnavailableReason value from code, so the series stay bounded. */
  recordCodGateRefusal(gate: string): void {
    this.codGateRefusals.add(1, { gate });
  }

  recordCodRemittanceDiscrepancy(kind: 'SHORT' | 'OVER'): void {
    this.codRemittanceDiscrepancies.add(1, { kind });
  }

  private boundedOperationName(name: string | null | undefined): string {
    if (!name) return 'anonymous';
    if (!OPERATION_NAME_PATTERN.test(name)) return 'other';
    if (this.operationNames.has(name)) return name;
    if (this.operationNames.size >= MAX_OPERATION_NAMES) return 'other';
    this.operationNames.add(name);
    return name;
  }
}

export function secondsSince(startMs: number): number {
  return (performance.now() - startMs) / 1000;
}
