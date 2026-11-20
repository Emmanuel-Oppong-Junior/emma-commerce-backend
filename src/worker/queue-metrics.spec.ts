import { OBSERVED_JOB_STATES, QueueMetrics } from './queue-metrics';

type Observation = [string, number, Record<string, string>?];

function build({
  backlog = { _count: { _all: 4 }, _min: { createdAt: new Date(Date.now() - 90_000) as Date | null } },
  aggregate = jest.fn().mockResolvedValue(backlog),
} = {}) {
  const gauges: string[] = [];
  const meter = {
    createObservableGauge: (name: string) => {
      gauges.push(name);
      return { name };
    },
    addBatchObservableCallback: jest.fn(),
    removeBatchObservableCallback: jest.fn(),
  };
  const counts = { waiting: 3, active: 1, delayed: 0, failed: 2 };
  const queue = (name: string) => ({ name, getJobCounts: jest.fn().mockResolvedValue(counts) });
  const logger = { warn: jest.fn() };
  const metrics = new QueueMetrics(
    meter as never,
    { outboxEvent: { aggregate } } as never,
    logger as never,
    queue('notifications') as never,
    queue('webhooks') as never,
    queue('maintenance') as never,
  );
  const observed: Observation[] = [];
  const result = {
    observe: (gauge: { name: string }, value: number, attributes?: Record<string, string>) =>
      observed.push([gauge.name, value, attributes]),
  };
  return { metrics, meter, gauges, logger, observed, result };
}

describe('QueueMetrics', () => {
  it('registers its gauges on init and unregisters the same callback on shutdown', () => {
    const { metrics, meter, gauges } = build();

    metrics.onModuleInit();
    metrics.onModuleDestroy();

    expect(gauges).toEqual(['queue_jobs', 'outbox_unpublished_events', 'outbox_oldest_unpublished_age_seconds']);
    expect(meter.addBatchObservableCallback).toHaveBeenCalledTimes(1);
    expect(meter.removeBatchObservableCallback.mock.calls[0][0]).toBe(
      meter.addBatchObservableCallback.mock.calls[0][0],
    );
  });

  it('observes job counts per queue and state, and the outbox backlog with the oldest row age', async () => {
    const { metrics, observed, result } = build();

    await metrics.observe(result as never);

    const jobs = observed.filter(([name]) => name === 'queue_jobs');
    expect(jobs).toHaveLength(3 * OBSERVED_JOB_STATES.length);
    expect(jobs).toContainEqual(['queue_jobs', 2, { queue: 'webhooks', state: 'failed' }]);
    expect(observed).toContainEqual(['outbox_unpublished_events', 4, undefined]);
    const age = observed.find(([name]) => name === 'outbox_oldest_unpublished_age_seconds')?.[1];
    expect(age).toBeGreaterThanOrEqual(90);
  });

  it('reports an oldest age of 0 when the outbox is empty', async () => {
    const { metrics, observed, result } = build({ backlog: { _count: { _all: 0 }, _min: { createdAt: null } } });

    await metrics.observe(result as never);

    expect(observed).toContainEqual(['outbox_oldest_unpublished_age_seconds', 0, undefined]);
  });

  it('logs a failed read and still observes the rest', async () => {
    const aggregate = jest.fn().mockRejectedValue(new Error('connection lost'));
    const { metrics, observed, result, logger } = build({ aggregate });

    await metrics.observe(result as never);

    expect(observed.some(([name]) => name === 'queue_jobs')).toBe(true);
    expect(observed.some(([name]) => name.startsWith('outbox_'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Outbox backlog unavailable for metrics | connection lost',
      'QueueMetrics',
    );
  });
});
