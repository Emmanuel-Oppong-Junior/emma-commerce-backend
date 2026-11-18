import { Prisma } from '../generated/prisma/client';
import { WebhookEventRepository } from './webhook-event.repository';

describe('WebhookEventRepository', () => {
  const webhookEvent = { create: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() };
  const repository = new WebhookEventRepository({ webhookEvent } as never);
  const incoming = {
    provider: 'PAYSTACK' as const,
    eventKey: 'charge.success:id:1',
    event: 'charge.success',
    reference: 'ref1',
    payload: { event: 'charge.success', data: { id: 1 } },
  };

  beforeEach(() => jest.clearAllMocks());

  it('stores a new delivery', async () => {
    webhookEvent.create.mockResolvedValue({ id: 'evt1' });

    await expect(repository.record(incoming)).resolves.toEqual({ created: true, event: { id: 'evt1' } });
    expect(webhookEvent.create).toHaveBeenCalledWith({ data: incoming });
  });

  it('returns the stored row for a delivery already recorded under the same key', async () => {
    webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    webhookEvent.findUniqueOrThrow.mockResolvedValue({ id: 'evt1', processedAt: null });

    await expect(repository.record(incoming)).resolves.toEqual({
      created: false,
      event: { id: 'evt1', processedAt: null },
    });
    expect(webhookEvent.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { provider_eventKey: { provider: 'PAYSTACK', eventKey: 'charge.success:id:1' } },
    });
  });

  it('does not hide any other database error', async () => {
    const failure = new Error('connection lost');
    webhookEvent.create.mockRejectedValue(failure);

    await expect(repository.record(incoming)).rejects.toBe(failure);
  });

  it('finds unprocessed events received before the cutoff and under the attempt cap, oldest first', async () => {
    const cutoff = new Date('2026-11-18T01:25:00.000Z');
    webhookEvent.findMany.mockResolvedValue([]);

    await repository.findUnprocessed(cutoff, 20, 30);

    expect(webhookEvent.findMany).toHaveBeenCalledWith({
      where: { processedAt: null, receivedAt: { lt: cutoff }, attempts: { lt: 20 } },
      orderBy: { receivedAt: 'asc' },
      take: 30,
    });
  });

  it('marks an event processed only while it is still unprocessed', async () => {
    await repository.markProcessed('evt1', 2);

    expect(webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt1', processedAt: null },
      data: { processedAt: expect.any(Date), attempts: { increment: 2 }, lastError: null },
    });
  });

  it('records a failure with a bounded error message', async () => {
    await repository.recordFailure('evt1', 3, 'x'.repeat(2000));

    const { data } = webhookEvent.updateMany.mock.calls[0][0];
    expect(data.attempts).toEqual({ increment: 3 });
    expect(data.lastError).toHaveLength(500);
  });
});
