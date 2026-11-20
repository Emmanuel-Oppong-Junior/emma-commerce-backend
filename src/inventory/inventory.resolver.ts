import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InventoryService } from './inventory.service';
import { StockMovementsArgs } from './dto/stock-movements.args';
import { StockMovement, StockMovementPage } from './entities/stock-movement.entity';
import { RestockVariantInput } from './dto/restock.input';
import { AdjustVariantStockInput } from './dto/adjust-stock.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => StockMovement)
export class InventoryResolver {
  constructor(private readonly inventoryService: InventoryService) {}

  @RequirePermission('inventory.adjust')
  @Mutation(() => StockMovement, {
    description: 'Add stock to a variant: a RECEIPT, or a RETURN_RESTOCK with returnRequestId (admin only)',
  })
  restockVariant(@ActiveUser('id') actorId: string, @Args('input') input: RestockVariantInput) {
    return this.inventoryService.restockVariant(input, actorId);
  }

  @RequirePermission('inventory.adjust')
  @Mutation(() => StockMovement, {
    description: 'Change a variant’s on-hand stock by a signed amount with a reason, never below reserved (admin only)',
  })
  adjustVariantStock(@ActiveUser('id') actorId: string, @Args('input') input: AdjustVariantStockInput) {
    return this.inventoryService.adjustVariantStock(input, actorId);
  }

  @RequirePermission('inventory.view')
  @Query(() => StockMovementPage, {
    description: 'Stock ledger entries, newest first, optionally of one variant or product (admin only)',
  })
  stockMovements(@Args() { variantId, productId, reason, first, after }: StockMovementsArgs) {
    return this.inventoryService.getMovements({ variantId, productId, reason }, first, after);
  }
}
