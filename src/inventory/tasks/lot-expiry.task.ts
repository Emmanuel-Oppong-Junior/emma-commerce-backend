import { Injectable } from '@nestjs/common';
import { LoggerService } from '../../commons/logger.service';
import { ExpiryRun, LotsService } from '../lots/lots.service';

const CONTEXT = 'LotExpiryTask';

/**
 * Repeatable job (hourly): writes the units of expired lots off sellable stock (ADJUSTMENT, EXPIRED, ref the Lot).
 * Units held for open orders stay: the reservation is kept (the sale draws them if nothing fresher is left) and a
 * warning names the variant and location, so staff can swap the goods or cancel.
 */
@Injectable()
export class LotExpiryTask {
  constructor(
    private readonly lots: LotsService,
    private readonly logger: LoggerService,
  ) {}

  async writeOffExpired(): Promise<ExpiryRun | null> {
    const run = await this.lots.writeOffExpired(new Date());
    if (run === null) {
      this.logger.log('Skipped: another instance is already writing off expired lots', CONTEXT);
      return null;
    }
    for (const group of run.groups.filter((g) => g.blocked > 0)) {
      this.logger.warn('Expired lot units are held for open orders and were not written off', CONTEXT, { ...group });
    }
    const writtenOff = run.groups.reduce((sum, g) => sum + g.writtenOff, 0);
    this.logger.log(`Lot expiry done | locations: ${run.groups.length} | units written off: ${writtenOff}`, CONTEXT);
    return run;
  }
}
