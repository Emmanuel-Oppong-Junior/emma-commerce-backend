import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryResolver } from './inventory.resolver';
import { InventoryRepository } from './inventory.repository';
import { LowStockTask } from './tasks/low-stock.task';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [InventoryService, InventoryResolver, InventoryRepository, LowStockTask],
  exports: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
