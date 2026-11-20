import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  it('writes the event through the given transaction client and returns its id', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'evt_1' });
    const tx = { outboxEvent: { create } };

    const id = await new OutboxService().record(tx as never, {
      type: 'order.placed.v1',
      aggregateId: 'order_1',
      payload: { orderId: 'order_1' },
    });

    expect(id).toBe('evt_1');
    expect(create).toHaveBeenCalledWith({
      data: { type: 'order.placed.v1', aggregateId: 'order_1', payload: { orderId: 'order_1' } },
      select: { id: true },
    });
  });

  it('fails when the write fails, so the surrounding transaction rolls back', async () => {
    const tx = { outboxEvent: { create: jest.fn().mockRejectedValue(new Error('connection lost')) } };

    await expect(
      new OutboxService().record(tx as never, {
        type: 'order.placed.v1',
        aggregateId: 'order_1',
        payload: { orderId: 'order_1' },
      }),
    ).rejects.toThrow('connection lost');
  });
});
