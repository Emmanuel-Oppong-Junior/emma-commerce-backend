import { LowStockAlertsService, LOW_STOCK_DIGEST_LOCK_KEY } from './low-stock-alerts.service';
import { PendingLowStockAlert } from './low-stock-digest';

const tx = { tx: true } as never;
const NOW = new Date('2026-11-22T09:00:00Z');

function pending(id: string, available: number, threshold: number | null = 5): PendingLowStockAlert {
  return { id, variantId: `v-${id}`, locationId: 'store_main', available, threshold };
}

describe('LowStockAlertsService.sendDigest', () => {
  let repository: Record<string, jest.Mock>;
  let outbox: { record: jest.Mock };
  let service: LowStockAlertsService;

  beforeEach(() => {
    repository = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      lockPending: jest.fn().mockResolvedValue([]),
      markDropped: jest.fn(),
      markSent: jest.fn(),
      alertRecipientIds: jest.fn().mockResolvedValue(['owner1', 'clerk1']),
    };
    outbox = { record: jest.fn() };
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    service = new LowStockAlertsService(repository as never, outbox as never, prisma as never);
  });

  it('records one digest event per recipient for the alerts still low and marks them sent', async () => {
    repository.lockPending.mockResolvedValue([pending('a', 2), pending('b', 4)]);

    const run = await service.sendDigest('dg1', NOW);

    expect(repository.tryAdvisoryLock).toHaveBeenCalledWith(tx, LOW_STOCK_DIGEST_LOCK_KEY);
    expect(repository.markSent).toHaveBeenCalledWith(tx, 'dg1', [pending('a', 2), pending('b', 4)], NOW);
    expect(outbox.record.mock.calls).toEqual([
      [
        tx,
        {
          type: 'inventory.low_stock_digest.v1',
          aggregateId: 'dg1',
          payload: { digestId: 'dg1', recipientId: 'owner1' },
        },
      ],
      [
        tx,
        {
          type: 'inventory.low_stock_digest.v1',
          aggregateId: 'dg1',
          payload: { digestId: 'dg1', recipientId: 'clerk1' },
        },
      ],
    ]);
    expect(run).toEqual({ digestId: 'dg1', listed: 2, dropped: 0, recipients: 2 });
  });

  it('drops alerts whose variant recovered, and sends nothing when none is still low', async () => {
    repository.lockPending.mockResolvedValue([pending('a', 9), pending('b', 6, null)]);

    const run = await service.sendDigest('dg1', NOW);

    expect(repository.markDropped).toHaveBeenCalledWith(tx, ['a', 'b'], NOW);
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
    expect(run).toEqual({ digestId: null, listed: 0, dropped: 2, recipients: 0 });
  });

  it('does nothing when nothing is pending', async () => {
    const run = await service.sendDigest('dg1', NOW);

    expect(repository.markDropped).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
    expect(run).toEqual({ digestId: null, listed: 0, dropped: 0, recipients: 0 });
  });

  it('skips when another run holds the lock', async () => {
    repository.tryAdvisoryLock.mockResolvedValue(false);

    await expect(service.sendDigest('dg1', NOW)).resolves.toBeNull();
    expect(repository.lockPending).not.toHaveBeenCalled();
  });
});
