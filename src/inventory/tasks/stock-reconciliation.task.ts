import { Injectable } from '@nestjs/common';
import { LoggerService } from '../../commons/logger.service';
import { AppMetrics } from '../../observability/metrics';
import { StockLedgerRepository } from '../stock-ledger.repository';
import {
  countByKind,
  lotMismatches,
  SERIAL_UNITS_MISMATCH,
  SerialUnitsMismatch,
  serialUnitsMismatch,
  StockMismatch,
  stockMismatches,
} from '../stock-reconciliation';
import { SerialUnitsRepository } from '../serials/serial-units.repository';

export const STOCK_RECONCILIATION_LOCK_KEY = 70_412_004;
const MAX_RUN_MS = 10 * 60 * 1000;
const CONTEXT = 'StockReconciliationTask';

/**
 * Nightly check that every StockLevel equals what its ledger says: the sum of its movements (on hand and reserved)
 * and the quantity of its ACTIVE reservations; that every lot's units equal its movements and, for lot-tracked
 * variants, the lots at a location add up to the level's onHand (P4-C.1); and, for serial-tracked variants, that the
 * units on each location's shelf match it (kind SERIAL_UNITS). Mismatches are counted on
 * `stock_reconciliation_mismatches` and logged with ids and numbers only; nothing is corrected, an admin investigates.
 */
@Injectable()
export class StockReconciliationTask {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
    private readonly serialUnits: SerialUnitsRepository,
  ) {}

  /** The mismatches found, or null when another instance is already reconciling. */
  async reconcile(): Promise<(StockMismatch | SerialUnitsMismatch)[] | null> {
    const found = await this.repository.runWithAdvisoryLock(STOCK_RECONCILIATION_LOCK_KEY, MAX_RUN_MS, async () => {
      const [disagreements, lotDisagreements, checked, shelves] = await Promise.all([
        this.repository.findLedgerDisagreements(),
        this.repository.findLotDisagreements(),
        this.repository.countLevels(),
        this.serialUnits.findShelfDisagreements(),
      ]);
      const serial = shelves
        .map(serialUnitsMismatch)
        .filter((mismatch): mismatch is SerialUnitsMismatch => mismatch !== null);
      return {
        mismatches: [...disagreements.flatMap(stockMismatches), ...lotMismatches(lotDisagreements)],
        serial,
        checked,
      };
    });
    if (found === null) {
      this.logger.log('Skipped: another instance is already reconciling stock', CONTEXT);
      return null;
    }
    const { mismatches, serial, checked } = found;
    for (const mismatch of [...mismatches, ...serial]) {
      this.logger.warn(`Stock ledger mismatch | kind: ${mismatch.kind}`, CONTEXT, { ...mismatch });
    }
    this.metrics.recordStockMismatches(countByKind(mismatches));
    if (serial.length > 0) this.metrics.recordStockMismatches({ [SERIAL_UNITS_MISMATCH]: serial.length });
    const total = mismatches.length + serial.length;
    this.logger.log(`Stock reconciliation done | levels: ${checked} | mismatches: ${total}`, CONTEXT);
    return [...mismatches, ...serial];
  }
}
