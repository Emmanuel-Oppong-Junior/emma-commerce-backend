import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { TaxModule } from '../tax/tax.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PriceHistoryModule } from '../price-history/price-history.module';
import { ImportsController } from './imports.controller';
import { ImportsResolver } from './imports.resolver';
import { ImportsService } from './imports.service';
import { ImportFactsRepository } from './import-facts.repository';
import { ImportValidator } from './import-validator';
import { ImportApplier } from './import-applier';
import { ImportRetentionTask } from './import-retention.task';

/** Bulk CSV/Excel imports (P8-I). The queue processor (ImportsProcessor) is registered in WorkerModule only. */
@Module({
  imports: [CommonsModule, TaxModule, InventoryModule, PriceHistoryModule],
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ImportsResolver,
    ImportFactsRepository,
    ImportValidator,
    ImportApplier,
    ImportRetentionTask,
  ],
  exports: [ImportValidator, ImportApplier, ImportRetentionTask],
})
export class ImportsModule {}
