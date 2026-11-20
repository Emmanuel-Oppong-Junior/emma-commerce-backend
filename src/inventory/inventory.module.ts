import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryResolver } from './inventory.resolver';
import { CommonsModule } from '../commons/commons.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockLedgerService } from './stock-ledger.service';
import { VariantStockLoader, VariantStockResolver } from './variant-stock.resolver';

@Module({
  imports: [CommonsModule, OutboxModule],
  providers: [
    InventoryService,
    InventoryResolver,
    StockLedgerRepository,
    StockLedgerService,
    VariantStockLoader,
    VariantStockResolver,
  ],
  exports: [InventoryService, StockLedgerService, StockLedgerRepository],
})
export class InventoryModule {}
