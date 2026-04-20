import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InventoryService } from './inventory.service';
import { InventoryLogEntity } from './entities/inventory-log.entity';
import { RestockProductInput, RestockVariantInput } from './dto/restock.input';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver(() => InventoryLogEntity)
export class InventoryResolver {
  constructor(private readonly inventoryService: InventoryService) {}

  @Mutation(() => InventoryLogEntity, { description: 'Restock a product (admin only)' })
  restockProduct(@ActiveUser('id') actorId: string, @Args('input') input: RestockProductInput) {
    return this.inventoryService.restockProduct(input, actorId);
  }

  @Mutation(() => InventoryLogEntity, { description: 'Restock a product variant (admin only)' })
  restockVariant(@ActiveUser('id') actorId: string, @Args('input') input: RestockVariantInput) {
    return this.inventoryService.restockVariant(input, actorId);
  }

  @Query(() => [InventoryLogEntity], { description: 'Get all inventory logs (admin only)' })
  inventoryLogs() {
    return this.inventoryService.getAllLogs();
  }

  @Query(() => [InventoryLogEntity], { description: 'Get inventory logs for a product (admin only)' })
  productInventoryLogs(@Args('productId', { type: () => ID }) productId: string) {
    return this.inventoryService.getProductLogs(productId);
  }

  @Query(() => [InventoryLogEntity], { description: 'Get inventory logs for a variant (admin only)' })
  variantInventoryLogs(@Args('variantId', { type: () => ID }) variantId: string) {
    return this.inventoryService.getVariantLogs(variantId);
  }
}
