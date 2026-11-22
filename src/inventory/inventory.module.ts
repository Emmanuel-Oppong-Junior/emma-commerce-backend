import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryResolver } from './inventory.resolver';
import { CommonsModule } from '../commons/commons.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockLedgerService } from './stock-ledger.service';
import { VariantStockLoader, VariantStockResolver } from './variant-stock.resolver';
import { StockTakeRepository } from './stock-take/stock-take.repository';
import { LowStockAlertsRepository } from './low-stock/low-stock-alerts.repository';
import { LowStockAlertsService } from './low-stock/low-stock-alerts.service';
import { StockTakeService } from './stock-take/stock-take.service';
import { StockTakeLineCountLoader, StockTakeResolver } from './stock-take/stock-take.resolver';

@Module({
  imports: [CommonsModule, OutboxModule],
  providers: [
    InventoryService,
    InventoryResolver,
    StockLedgerRepository,
    StockLedgerService,
    VariantStockLoader,
    VariantStockResolver,
    StockTakeRepository,
    StockTakeService,
    StockTakeResolver,
    StockTakeLineCountLoader,
    LowStockAlertsRepository,
    LowStockAlertsService,
  ],
  exports: [InventoryService, StockLedgerService, StockLedgerRepository, LowStockAlertsService],
})
export class InventoryModule {}
