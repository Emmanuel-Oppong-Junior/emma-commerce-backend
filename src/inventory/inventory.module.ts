import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryResolver } from './inventory.resolver';
import { CommonsModule } from '../commons/commons.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockLedgerService } from './stock-ledger.service';
import { VariantStockLoader, VariantStockResolver } from './variant-stock.resolver';
import { StockLocationsRepository } from './locations/stock-locations.repository';
import { StockLocationsService } from './locations/stock-locations.service';
import {
  PickupLocationFulfilmentResolver,
  ShippingZoneFulfilmentResolver,
  StockLocationsResolver,
} from './locations/stock-locations.resolver';
import { StockTransfersRepository } from './transfers/stock-transfers.repository';
import { StockTransfersService } from './transfers/stock-transfers.service';
import { StockTransferLineResolver, StockTransfersResolver } from './transfers/stock-transfers.resolver';
import { StockTakeRepository } from './stock-take/stock-take.repository';
import { LowStockAlertsRepository } from './low-stock/low-stock-alerts.repository';
import { LowStockAlertsService } from './low-stock/low-stock-alerts.service';
import { StockTakeService } from './stock-take/stock-take.service';
import { StockTakeLineCountLoader, StockTakeResolver } from './stock-take/stock-take.resolver';
import { LotStockRepository } from './lots/lot-stock.repository';
import { LotsService } from './lots/lots.service';
import { LotLoader, LotsResolver, StockMovementLotResolver } from './lots/lots.resolver';
import { SerialUnitsRepository } from './serials/serial-units.repository';
import { SerialUnitsService } from './serials/serial-units.service';

@Module({
  imports: [CommonsModule, OutboxModule],
  providers: [
    InventoryService,
    InventoryResolver,
    StockLedgerRepository,
    StockLedgerService,
    VariantStockLoader,
    VariantStockResolver,
    StockLocationsRepository,
    StockLocationsService,
    StockLocationsResolver,
    ShippingZoneFulfilmentResolver,
    PickupLocationFulfilmentResolver,
    StockTransfersRepository,
    StockTransfersService,
    StockTransfersResolver,
    StockTransferLineResolver,
    StockTakeRepository,
    StockTakeService,
    StockTakeResolver,
    StockTakeLineCountLoader,
    LowStockAlertsRepository,
    LowStockAlertsService,
    LotStockRepository,
    LotsService,
    LotsResolver,
    LotLoader,
    StockMovementLotResolver,
    SerialUnitsRepository,
    SerialUnitsService,
  ],
  exports: [
    InventoryService,
    StockLedgerService,
    StockLedgerRepository,
    StockLocationsService,
    StockLocationsRepository,
    LowStockAlertsService,
    LotsService,
    SerialUnitsService,
    SerialUnitsRepository,
  ],
})
export class InventoryModule {}
