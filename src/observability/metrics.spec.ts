import { EventEmitter } from 'node:events';
import { Job } from 'bullmq';
import { AppMetrics, MAX_OPERATION_NAMES } from './metrics';
import { graphqlMetricsPlugin } from './graphql-metrics.plugin';
import { HttpMetricsMiddleware, routeTemplate } from './http-metrics.middleware';

type Sample = { value: number; attributes: Record<string, unknown> };

/** A Meter that keeps what each instrument recorded, by instrument name. */
function fakeMeter() {
  const samples: Record<string, Sample[]> = {};
  const instrument = (name: string) => {
    samples[name] = [];
    const keep = (value: number, attributes: Record<string, unknown> = {}) => samples[name].push({ value, attributes });
    return { record: keep, add: keep };
  };
  return { meter: { createHistogram: instrument, createCounter: instrument }, samples };
}

function build() {
  const { meter, samples } = fakeMeter();
  return { metrics: new AppMetrics(meter as never), samples };
}

describe('AppMetrics', () => {
  describe('HTTP', () => {
    it('records duration by method, route template and status class', () => {
      const { metrics, samples } = build();

      metrics.recordHttpRequest({ method: 'get', route: '/payment/verify/:reference', status: 200, seconds: 0.12 });

      expect(samples.http_request_duration_seconds).toEqual([
        { value: 0.12, attributes: { method: 'GET', route: '/payment/verify/:reference', status_class: '2xx' } },
      ]);
      expect(samples.api_errors).toEqual([]);
    });

    it('folds unknown methods into OTHER so clients cannot add series', () => {
      const { metrics, samples } = build();

      metrics.recordHttpRequest({ method: 'PROPFIND', route: 'unmatched', status: 404, seconds: 0.001 });

      expect(samples.http_request_duration_seconds[0].attributes.method).toBe('OTHER');
    });

    it.each([
      [500, 'INTERNAL_SERVER_ERROR'],
      [503, 'INTERNAL_SERVER_ERROR'],
      [401, 'UNAUTHENTICATED'],
      [404, 'NOT_FOUND'],
      [429, 'BAD_REQUEST'],
    ])('counts a REST %i as error code %s', (status, code) => {
      const { metrics, samples } = build();

      metrics.recordHttpRequest({ method: 'POST', route: '/payment/webhook', status, seconds: 0.01 });

      expect(samples.api_errors).toEqual([{ value: 1, attributes: { transport: 'http', code } }]);
    });

    it('leaves GraphQL errors to the GraphQL plugin (no double count of an HTTP 400 on /graphql)', () => {
      const { metrics, samples } = build();

      metrics.recordHttpRequest({ method: 'POST', route: '/graphql', status: 400, seconds: 0.01 });

      expect(samples.api_errors).toEqual([]);
    });
  });

  describe('GraphQL', () => {
    it('records an operation with its name, type and outcome, and counts each error code', () => {
      const { metrics, samples } = build();

      metrics.recordGraphqlOperation({
        operation: { name: 'PlaceOrder', type: 'mutation' },
        errorCodes: [],
        seconds: 0.3,
      });
      metrics.recordGraphqlOperation({
        operation: { name: 'PlaceOrder', type: 'mutation' },
        errorCodes: ['CONFLICT', 'INTERNAL_SERVER_ERROR'],
        seconds: 0.2,
      });

      expect(samples.graphql_operation_duration_seconds.map((sample) => sample.attributes)).toEqual([
        { operation_name: 'PlaceOrder', operation_type: 'mutation', outcome: 'ok' },
        { operation_name: 'PlaceOrder', operation_type: 'mutation', outcome: 'CONFLICT' },
      ]);
      expect(samples.api_errors.map((sample) => sample.attributes)).toEqual([
        { transport: 'graphql', code: 'CONFLICT' },
        { transport: 'graphql', code: 'INTERNAL_SERVER_ERROR' },
      ]);
    });

    it('groups unnamed operations, invalid documents and odd names', () => {
      const { metrics, samples } = build();

      metrics.recordGraphqlOperation({ operation: { name: null, type: 'query' }, errorCodes: [], seconds: 0.1 });
      metrics.recordGraphqlOperation({ errorCodes: ['GRAPHQL_VALIDATION_FAILED'], seconds: 0.1 });
      metrics.recordGraphqlOperation({
        operation: { name: 'x'.repeat(65), type: 'query' },
        errorCodes: [],
        seconds: 0,
      });

      expect(samples.graphql_operation_duration_seconds.map((sample) => sample.attributes)).toEqual([
        { operation_name: 'anonymous', operation_type: 'query', outcome: 'ok' },
        { operation_name: 'invalid', operation_type: 'unknown', outcome: 'GRAPHQL_VALIDATION_FAILED' },
        { operation_name: 'other', operation_type: 'query', outcome: 'ok' },
      ]);
    });

    it(`caps distinct operation names at ${MAX_OPERATION_NAMES}; later new names become "other"`, () => {
      const { metrics, samples } = build();
      const record = (name: string) =>
        metrics.recordGraphqlOperation({ operation: { name, type: 'query' }, errorCodes: [], seconds: 0 });

      for (let i = 0; i < MAX_OPERATION_NAMES; i += 1) record(`Op${i}`);
      record('OneTooMany');
      record('Op0');

      const names = samples.graphql_operation_duration_seconds.map((sample) => sample.attributes.operation_name);
      expect(names[names.length - 2]).toBe('other');
      expect(names[names.length - 1]).toBe('Op0');
    });
  });

  describe('jobs', () => {
    const job = { queueName: 'notifications', name: 'email.welcome.v1', id: 'job-1' } as Job;

    it('times a completed job', async () => {
      const { metrics, samples } = build();

      await expect(metrics.observeJob(job, async () => 'sent')).resolves.toBe('sent');

      expect(samples.job_duration_seconds).toEqual([
        {
          value: expect.any(Number),
          attributes: { queue: 'notifications', name: 'email.welcome.v1', outcome: 'completed' },
        },
      ]);
      expect(samples.job_failures).toEqual([]);
    });

    it('times and counts a failed attempt, and rethrows it for BullMQ to retry', async () => {
      const { metrics, samples } = build();

      await expect(
        metrics.observeJob(job, async () => {
          throw new Error('Resend down');
        }),
      ).rejects.toThrow('Resend down');

      expect(samples.job_duration_seconds[0].attributes.outcome).toBe('failed');
      expect(samples.job_failures).toEqual([
        { value: 1, attributes: { queue: 'notifications', name: 'email.welcome.v1' } },
      ]);
    });
  });

  it('counts webhook failures by reason and reconciliation mismatches by kind (zero kinds skipped)', () => {
    const { metrics, samples } = build();

    metrics.recordWebhookFailure('invalid_signature');
    metrics.recordReconciliationMismatches({ PAYSTACK_ONLY: 2, UNSETTLED: 0, AMOUNT_MISMATCH: 1 });

    expect(samples.webhook_processing_failures).toEqual([
      { value: 1, attributes: { provider: 'paystack', reason: 'invalid_signature' } },
    ]);
    expect(samples.payment_reconciliation_mismatches).toEqual([
      { value: 2, attributes: { kind: 'PAYSTACK_ONLY' } },
      { value: 1, attributes: { kind: 'AMOUNT_MISMATCH' } },
    ]);
  });

  it('counts stock reconciliation mismatches by kind (zero kinds skipped)', () => {
    const { metrics, samples } = build();

    metrics.recordStockMismatches({ ON_HAND: 1, RESERVED_MOVEMENTS: 0, ACTIVE_RESERVATIONS: 3 });

    expect(samples.stock_reconciliation_mismatches).toEqual([
      { value: 1, attributes: { kind: 'ON_HAND' } },
      { value: 3, attributes: { kind: 'ACTIVE_RESERVATIONS' } },
    ]);
  });

  it('counts velocity limit hits by rule and level, and velocity check errors by stage', () => {
    const { metrics, samples } = build();

    metrics.recordVelocityLimitHit('ORDERS_PER_IP_1H', 'HARD');
    metrics.recordVelocityCheckError('screen');

    expect(samples.velocity_limit_hits).toEqual([
      { value: 1, attributes: { rule: 'ORDERS_PER_IP_1H', level: 'HARD' } },
    ]);
    expect(samples.velocity_check_errors).toEqual([{ value: 1, attributes: { stage: 'screen' } }]);
  });

  it('counts COD remittance discrepancies by kind only', () => {
    const { metrics, samples } = build();

    metrics.recordCodRemittanceDiscrepancy('SHORT');
    metrics.recordCodRemittanceDiscrepancy('OVER');

    expect(samples.cod_remittance_discrepancies).toEqual([
      { value: 1, attributes: { kind: 'SHORT' } },
      { value: 1, attributes: { kind: 'OVER' } },
    ]);
  });

  it('counts refused delivery codes by result and overrides with no labels', () => {
    const { metrics, samples } = build();

    metrics.recordDeliveryCodeFailure('WRONG_CODE');
    metrics.recordDeliveryCodeFailure('LOCKED');
    metrics.recordDeliveryOverride();

    expect(samples.delivery_code_failures).toEqual([
      { value: 1, attributes: { result: 'WRONG_CODE' } },
      { value: 1, attributes: { result: 'LOCKED' } },
    ]);
    expect(samples.delivery_overrides).toEqual([{ value: 1, attributes: {} }]);
  });

  it('counts SMS by template and outcome', () => {
    const { metrics, samples } = build();

    metrics.recordSms('account.phone_otp', 'sent');
    metrics.recordSms('shipment.delivered', 'failed');

    expect(samples.sms_messages).toEqual([
      { value: 1, attributes: { template: 'account.phone_otp', outcome: 'sent' } },
      { value: 1, attributes: { template: 'shipment.delivered', outcome: 'failed' } },
    ]);
  });
});

describe('routeTemplate', () => {
  it.each([
    [
      { route: { path: '/verify/:reference' }, baseUrl: '/payment', originalUrl: '/payment/verify/ref_123' },
      '/payment/verify/:reference',
    ],
    [{ route: undefined, baseUrl: '', originalUrl: '/graphql?query={me{id}}' }, '/graphql'],
    [{ route: undefined, baseUrl: '', originalUrl: '/wp-login.php' }, 'unmatched'],
  ])('maps %j to %s, never the raw path', (req, expected) => {
    expect(routeTemplate(req as never)).toBe(expected);
  });
});

describe('HttpMetricsMiddleware', () => {
  it('records the request once the response is finished', () => {
    const { metrics, samples } = build();
    const res = Object.assign(new EventEmitter(), { statusCode: 201 });
    const req = {
      method: 'POST',
      route: { path: '/payment/initialize' },
      baseUrl: '',
      originalUrl: '/payment/initialize',
    };
    const next = jest.fn();

    new HttpMetricsMiddleware(metrics).use(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(samples.http_request_duration_seconds).toEqual([]);

    res.emit('finish');
    expect(samples.http_request_duration_seconds[0].attributes).toEqual({
      method: 'POST',
      route: '/payment/initialize',
      status_class: '2xx',
    });
  });
});

describe('graphqlMetricsPlugin', () => {
  async function run(
    operation: { operationName: string | null; type: 'query' | 'mutation' } | undefined,
    errors?: object[],
  ) {
    const { metrics, samples } = build();
    const listener = await graphqlMetricsPlugin(metrics).requestDidStart!({} as never);
    if (operation) {
      await listener!.didResolveOperation!({
        operationName: operation.operationName,
        operation: { operation: operation.type },
      } as never);
    }
    await listener!.willSendResponse!({ response: { body: { kind: 'single', singleResult: { errors } } } } as never);
    return samples;
  }

  it('records one sample per operation with the codes the client saw', async () => {
    const samples = await run({ operationName: 'MyOrders', type: 'query' }, [
      { message: 'x', extensions: { code: 'FORBIDDEN' } },
    ]);

    expect(samples.graphql_operation_duration_seconds[0].attributes).toEqual({
      operation_name: 'MyOrders',
      operation_type: 'query',
      outcome: 'FORBIDDEN',
    });
  });

  it('records a document that failed parsing or validation as "invalid"', async () => {
    const samples = await run(undefined, [{ message: 'Syntax Error', extensions: { code: 'GRAPHQL_PARSE_FAILED' } }]);

    expect(samples.graphql_operation_duration_seconds[0].attributes).toEqual({
      operation_name: 'invalid',
      operation_type: 'unknown',
      outcome: 'GRAPHQL_PARSE_FAILED',
    });
  });
});
