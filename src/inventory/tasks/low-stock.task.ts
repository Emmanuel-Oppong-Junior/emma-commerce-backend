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
    const [products, variants] = await Promise.all([
      this.inventoryRepository.findLowStockProducts(),
      this.inventoryRepository.findLowStockVariants(),
    ]);

    if (products.length > 0) {
      this.logger.warn(`Low stock alert: ${products.length} product(s) below threshold`, 'LowStockTask');
      for (const p of products) {
        this.logger.warn(
          `Low stock — product "${p.name}" (${p.id}): qty=${p.quantity}, threshold=${p.lowStockAlert ?? 5}`,
          'LowStockTask',
        );
      }
    }

    if (variants.length > 0) {
      this.logger.warn(`Low stock alert: ${variants.length} variant(s) below threshold`, 'LowStockTask');
      for (const v of variants) {
        this.logger.warn(
          `Low stock — variant "${v.id}" (product: ${v.productId}): qty=${v.quantity}, threshold=${v.lowStockThreshold ?? 5}`,
          'LowStockTask',
        );
      }
    }
  }
}
