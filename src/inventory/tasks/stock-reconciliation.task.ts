import { Injectable } from '@nestjs/common';
import { LoggerService } from '../../commons/logger.service';
import { AppMetrics } from '../../observability/metrics';
import { StockLedgerRepository } from '../stock-ledger.repository';
import { countByKind, StockMismatch, stockMismatches } from '../stock-reconciliation';

export const STOCK_RECONCILIATION_LOCK_KEY = 70_412_004;
const MAX_RUN_MS = 10 * 60 * 1000;
const CONTEXT = 'StockReconciliationTask';

/**
 * Nightly check that every StockLevel equals what its ledger says: the sum of its movements (on hand and reserved)
 * and the quantity of its ACTIVE reservations. Mismatches are counted on `stock_reconciliation_mismatches` and logged
 * with ids and numbers only; nothing is corrected, an admin investigates.
 */
@Injectable()
export class StockReconciliationTask {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
  ) {}

  /** The mismatches found, or null when another instance is already reconciling. */
  async reconcile(): Promise<StockMismatch[] | null> {
    const found = await this.repository.runWithAdvisoryLock(STOCK_RECONCILIATION_LOCK_KEY, MAX_RUN_MS, async () => {
      const [disagreements, checked] = await Promise.all([
        this.repository.findLedgerDisagreements(),
        this.repository.countLevels(),
      ]);
      return { mismatches: disagreements.flatMap(stockMismatches), checked };
    });
    if (found === null) {
      this.logger.log('Skipped: another instance is already reconciling stock', CONTEXT);
      return null;
    }
    const { mismatches, checked } = found;
    for (const mismatch of mismatches) {
      this.logger.warn(`Stock ledger mismatch | kind: ${mismatch.kind}`, CONTEXT, { ...mismatch });
    }
    this.metrics.recordStockMismatches(countByKind(mismatches));
    this.logger.log(`Stock reconciliation done | levels: ${checked} | mismatches: ${mismatches.length}`, CONTEXT);
    return mismatches;
  }
}
