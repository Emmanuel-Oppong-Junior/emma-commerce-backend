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
  ],
  exports: [
    InventoryService,
    StockLedgerService,
    StockLedgerRepository,
    StockLocationsService,
    StockLocationsRepository,
  ],
})
export class InventoryModule {}
