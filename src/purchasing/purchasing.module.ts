import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SuppliersService } from './suppliers/suppliers.service';
import { SuppliersResolver } from './suppliers/suppliers.resolver';
import { PurchaseOrdersRepository } from './purchase-orders/purchase-orders.repository';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { PurchaseOrdersResolver } from './purchase-orders/purchase-orders.resolver';
import { VariantCostService } from './cost/variant-cost.service';
import { CostHistoryResolver, VariantCostLoader, VariantCostResolver } from './cost/variant-cost.resolver';

/** Suppliers, purchase orders and receiving into stock, and the weighted-average cost of variants (P4-E.1). */
@Module({
  imports: [CommonsModule, InventoryModule],
  providers: [
    SuppliersService,
    SuppliersResolver,
    PurchaseOrdersRepository,
    PurchaseOrdersService,
    PurchaseOrdersResolver,
    VariantCostService,
    VariantCostLoader,
    VariantCostResolver,
    CostHistoryResolver,
  ],
})
export class PurchasingModule {}
