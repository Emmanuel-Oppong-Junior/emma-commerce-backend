import { Injectable } from '@nestjs/common';
import { InventoryRepository } from '../inventory.repository';
import { LoggerService } from '../../commons/logger.service';

@Injectable()
export class LowStockTask {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly logger: LoggerService,
  ) {}

  async checkLowStock(): Promise<void> {
    const variants = await this.inventoryRepository.findLowStockVariants();
    if (variants.length === 0) return;

    this.logger.warn(`Low stock alert: ${variants.length} variant(s) below threshold`, 'LowStockTask');
    for (const v of variants) {
      this.logger.warn(
        `Low stock — variant ${v.sku} (${v.id}, product ${v.productId}): qty=${v.quantity}, threshold=${v.lowStockThreshold ?? 5}`,
        'LowStockTask',
      );
    }
  }
}
