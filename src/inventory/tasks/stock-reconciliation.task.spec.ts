import { STOCK_RECONCILIATION_LOCK_KEY, StockReconciliationTask } from './stock-reconciliation.task';

describe('StockReconciliationTask', () => {
  const drifted = {
    variantId: 'v1',
    locationId: 'loc',
    onHand: 9,
    reserved: 0,
    movedOnHand: 10,
    movedReserved: 0,
    activeReserved: 0,
  };
  let repository: Record<string, jest.Mock>;
  let logger: { log: jest.Mock; warn: jest.Mock };
  let metrics: { recordStockMismatches: jest.Mock };
  let task: StockReconciliationTask;

  beforeEach(() => {
    repository = {
      runWithAdvisoryLock: jest.fn((_key, _ms, fn: () => Promise<unknown>) => fn()),
      findLedgerDisagreements: jest.fn().mockResolvedValue([drifted]),
      findLotDisagreements: jest.fn().mockResolvedValue([]),
      countLevels: jest.fn().mockResolvedValue(40),
    };
    logger = { log: jest.fn(), warn: jest.fn() };
    metrics = { recordStockMismatches: jest.fn() };
    task = new StockReconciliationTask(
      repository as never,
      logger as never,
      metrics as never,
      {
        findShelfDisagreements: jest.fn().mockResolvedValue([]),
      } as never,
    );
  });

  it('runs under its advisory lock and records each mismatch as a metric and a log line with ids only', async () => {
    const mismatches = await task.reconcile();

    expect(repository.runWithAdvisoryLock).toHaveBeenCalledWith(
      STOCK_RECONCILIATION_LOCK_KEY,
      expect.any(Number),
      expect.any(Function),
    );
    expect(mismatches).toEqual([{ kind: 'ON_HAND', variantId: 'v1', locationId: 'loc', expected: 10, actual: 9 }]);
    expect(metrics.recordStockMismatches).toHaveBeenCalledWith({
      ON_HAND: 1,
      RESERVED_MOVEMENTS: 0,
      ACTIVE_RESERVATIONS: 0,
      LOT_MOVEMENTS: 0,
      LOT_TOTAL: 0,
    });
    expect(logger.warn).toHaveBeenCalledWith('Stock ledger mismatch | kind: ON_HAND', 'StockReconciliationTask', {
      kind: 'ON_HAND',
      variantId: 'v1',
      locationId: 'loc',
      expected: 10,
      actual: 9,
    });
  });

  it('reports lots that disagree with their movements or with the level (P4-C.1)', async () => {
    repository.findLedgerDisagreements.mockResolvedValue([]);
    repository.findLotDisagreements.mockResolvedValue([
      { kind: 'LOT_TOTAL', variantId: 'v2', locationId: 'loc', lotId: null, expected: 5, actual: 3 },
    ]);

    const mismatches = await task.reconcile();

    expect(mismatches).toEqual([{ kind: 'LOT_TOTAL', variantId: 'v2', locationId: 'loc', expected: 5, actual: 3 }]);
    expect(metrics.recordStockMismatches).toHaveBeenCalledWith(expect.objectContaining({ LOT_TOTAL: 1 }));
  });

  it('skips the run, recording nothing, while another instance holds the lock', async () => {
    repository.runWithAdvisoryLock.mockResolvedValue(null);

    await expect(task.reconcile()).resolves.toBeNull();
    expect(metrics.recordStockMismatches).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
