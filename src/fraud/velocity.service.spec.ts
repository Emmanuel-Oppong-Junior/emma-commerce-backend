import { ForbiddenException } from '@nestjs/common';
import { VelocityService } from './velocity.service';
import { VelocityCheckpoint, VelocityEvent, velocitySubjects } from './velocity-rules';

describe('VelocityService', () => {
  const counter = { read: jest.fn(), increment: jest.fn() };
  const repository = {
    findLimits: jest.fn(),
    flagOrder: jest.fn(),
    upsertLimits: jest.fn(),
    findFlaggedOrders: jest.fn(),
    clearFlags: jest.fn(),
  };
  const tx = { tx: true };
  const auditService = {
    record: jest.fn((change: (t: unknown) => Promise<unknown>, entry: (r: unknown) => unknown) =>
      change(tx).then((result) => {
        auditService.entries.push(entry(result));
        return result;
      }),
    ),
    entries: [] as unknown[],
  };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const metrics = { recordVelocityLimitHit: jest.fn(), recordVelocityCheckError: jest.fn() };
  const service = new VelocityService(
    counter as never,
    repository as never,
    auditService as never,
    logger as never,
    metrics as never,
  );
  const subjects = velocitySubjects({ customerId: 'user-1', phone: '0244123456', ip: '41.66.1.2' });

  beforeEach(() => {
    jest.clearAllMocks();
    auditService.entries = [];
    repository.findLimits.mockResolvedValue([{ rule: 'ORDERS_PER_CUSTOMER_1H', softLimit: 1, hardLimit: 2 }]);
  });

  describe('screenOrRefuse at placement', () => {
    it('counts the order being placed: one earlier order is at the soft limit of 1, so the new one is flagged SOFT', async () => {
      counter.read.mockResolvedValue([1, 0, 0, 0, 0]);

      const hits = await service.screenOrRefuse(VelocityCheckpoint.ORDER_PLACEMENT, subjects);

      expect(hits).toEqual([{ rule: 'ORDERS_PER_CUSTOMER_1H', level: 'SOFT', count: 2, limit: 1 }]);
      expect(metrics.recordVelocityLimitHit).toHaveBeenCalledWith('ORDERS_PER_CUSTOMER_1H', 'SOFT');
    });

    it('refuses with FORBIDDEN and reason VELOCITY_LIMIT above a hard limit, naming no rule or threshold', async () => {
      counter.read.mockResolvedValue([2, 0, 0, 0, 0]);

      const error = await service.screenOrRefuse(VelocityCheckpoint.ORDER_PLACEMENT, subjects).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        message: expect.stringContaining('Too many orders'),
        extensions: { reason: 'VELOCITY_LIMIT' },
      });
      expect(metrics.recordVelocityLimitHit).toHaveBeenCalledWith('ORDERS_PER_CUSTOMER_1H', 'HARD');
    });

    it('lets the order through with an error log and metric when Redis fails (fail-open)', async () => {
      counter.read.mockRejectedValue(new Error('Connection is closed.'));

      await expect(service.screenOrRefuse(VelocityCheckpoint.ORDER_PLACEMENT, subjects)).resolves.toEqual([]);
      expect(metrics.recordVelocityCheckError).toHaveBeenCalledWith('screen');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('fail-open'), expect.anything(), 'Velocity');
    });

    it('logs hits without the phone number or IP address', async () => {
      counter.read.mockResolvedValue([5, 5, 50, 50, 500]);

      await service.screen(VelocityCheckpoint.ORDER_PLACEMENT, subjects);

      const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
      for (const raw of ['233244123456', '0244123456', '41.66.1.2']) expect(logged).not.toContain(raw);
    });
  });

  describe('record', () => {
    it('increments every counter of the event with its window', async () => {
      counter.increment.mockResolvedValue([1, 1]);

      await service.record(VelocityEvent.PAYMENT_STARTED, subjects);

      expect(counter.increment).toHaveBeenCalledWith([
        { key: expect.stringMatching(/^velocity:PAYMENT_ATTEMPTS_PER_CUSTOMER_1H:[0-9a-f]{64}$/), windowSeconds: 3600 },
        { key: expect.stringMatching(/^velocity:PAYMENT_ATTEMPTS_PER_IP_1H:[0-9a-f]{64}$/), windowSeconds: 3600 },
      ]);
    });

    it('only logs and counts the failure when Redis is down: the event already happened', async () => {
      counter.increment.mockRejectedValue(new Error('Connection is closed.'));

      await expect(service.record(VelocityEvent.ORDER_PLACED, subjects)).resolves.toBeUndefined();
      expect(metrics.recordVelocityCheckError).toHaveBeenCalledWith('record');
    });
  });

  describe('updateLimits', () => {
    it('validates before writing anything', async () => {
      await expect(
        service.updateLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 5, hardLimit: 2 }], 'owner-1'),
      ).rejects.toThrow('hardLimit (2) must be at least softLimit (5)');
      expect(repository.upsertLimits).not.toHaveBeenCalled();
    });

    it('writes the limits and the audit row in one transaction with the before and after values', async () => {
      repository.findLimits
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80 }])
        .mockResolvedValue([{ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80 }]);
      repository.upsertLimits.mockResolvedValue('store-1');

      const view = await service.updateLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80 }], 'owner-1');

      expect(repository.upsertLimits).toHaveBeenCalledWith(
        tx,
        [expect.objectContaining({ rule: 'ORDERS_PER_IP_1H' })],
        'owner-1',
      );
      expect(auditService.entries).toEqual([
        {
          entity: 'VelocityLimit',
          entityId: 'store-1',
          action: 'UPDATE',
          userId: 'owner-1',
          details: {
            changes: {
              ORDERS_PER_IP_1H: { from: { softLimit: 10, hardLimit: 30 }, to: { softLimit: 50, hardLimit: 80 } },
            },
          },
        },
      ]);
      expect(view.find((limit) => limit.rule === 'ORDERS_PER_IP_1H')).toMatchObject({
        softLimit: 50,
        hardLimit: 80,
        isDefault: false,
      });
      expect(view.find((limit) => limit.rule === 'ORDERS_PER_CUSTOMER_1H')).toMatchObject({ isDefault: true });
    });
  });

  it('clears flags with an audit row in the same transaction', async () => {
    repository.clearFlags.mockResolvedValue([{ id: 'flag-1', rule: 'ORDERS_PER_IP_1H', level: 'SOFT' }]);

    await service.clearFlags('order-1', 'Known reseller', 'staff-1');

    expect(repository.clearFlags).toHaveBeenCalledWith(tx, 'order-1', 'staff-1', 'Known reseller');
    expect(auditService.entries).toEqual([
      {
        entity: 'Order',
        entityId: 'order-1',
        action: 'UPDATE',
        userId: 'staff-1',
        details: {
          reviewFlagsCleared: [{ id: 'flag-1', rule: 'ORDERS_PER_IP_1H', level: 'SOFT' }],
          note: 'Known reseller',
        },
      },
    ]);
  });
});
