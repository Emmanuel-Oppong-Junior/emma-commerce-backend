import { OutboxRelay, RELAY_MAX_ATTEMPTS } from './outbox.relay';

interface Row {
  id: string;
  type: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  requestId?: string | null;
}

function buildRelay(rows: Row[], add = jest.fn().mockResolvedValue({})) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: rows.length }), update: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const notifications = { add };
  const other = { add: jest.fn() };
  const relay = new OutboxRelay(
    prisma as never,
    logger as never,
    notifications as never,
    other as never,
    other as never,
  );
  return { relay, tx, add, logger, other };
}

const placed = (id: string, attempts = 0): Row => ({
  id,
  type: 'order.placed.v1',
  aggregateId: `order_${id}`,
  payload: { orderId: `order_${id}` },
  attempts,
});

describe('OutboxRelay.publishBatch', () => {
  it('adds one job per event to its queue with the event id as job id, then marks them published', async () => {
    const { relay, tx, add, other } = buildRelay([placed('e1'), placed('e2')]);

    await expect(relay.publishBatch()).resolves.toBe(2);

    expect(add).toHaveBeenNthCalledWith(
      1,
      'order.placed.v1',
      { eventId: 'e1', aggregateId: 'order_e1', payload: { orderId: 'order_e1' } },
      { jobId: 'e1' },
    );
    expect(add).toHaveBeenNthCalledWith(2, 'order.placed.v1', expect.objectContaining({ eventId: 'e2' }), {
      jobId: 'e2',
    });
    expect(other.add).not.toHaveBeenCalled();
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1', 'e2'] } },
      data: { publishedAt: expect.any(Date), attempts: { increment: 1 }, lastError: null },
    });
  });

  it('passes the recording request id to the job as meta, so worker logs correlate', async () => {
    const { relay, add } = buildRelay([
      { ...placed('e1'), requestId: 'req-1' },
      { ...placed('e2'), requestId: null },
    ]);

    await relay.publishBatch();

    expect(add).toHaveBeenNthCalledWith(
      1,
      'order.placed.v1',
      { eventId: 'e1', aggregateId: 'order_e1', payload: { orderId: 'order_e1' }, meta: { requestId: 'req-1' } },
      { jobId: 'e1' },
    );
    expect(add.mock.calls[1][1]).not.toHaveProperty('meta');
  });

  it('locks only unpublished rows under the attempt cap, skipping rows other relays hold', async () => {
    const { relay, tx } = buildRelay([]);

    await relay.publishBatch();

    const [strings, maxAttempts] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, number];
    const sql = strings.join('?');
    expect(sql).toContain('"publishedAt" IS NULL');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(maxAttempts).toBe(RELAY_MAX_ATTEMPTS);
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('records a failed add on that event and still publishes the rest of the batch', async () => {
    const add = jest.fn().mockRejectedValueOnce(new Error('Redis down')).mockResolvedValue({});
    const { relay, tx, logger } = buildRelay([placed('e1'), placed('e2')], add);

    await expect(relay.publishBatch()).resolves.toBe(1);

    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { attempts: { increment: 1 }, lastError: 'Redis down' },
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['e2'] } } }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('id: e1'), 'OutboxRelay');
  });

  it('never publishes an unknown event type and logs an error once the last attempt is spent', async () => {
    const { relay, tx, add, logger } = buildRelay([{ ...placed('e1', RELAY_MAX_ATTEMPTS - 1), type: 'order.lost.v1' }]);

    await expect(relay.publishBatch()).resolves.toBe(0);

    expect(add).not.toHaveBeenCalled();
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { attempts: { increment: 1 }, lastError: 'Unknown outbox event type "order.lost.v1"' },
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('giving up'), undefined, 'OutboxRelay');
  });
});
