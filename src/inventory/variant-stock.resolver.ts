import { Injectable, Scope } from '@nestjs/common';
import { Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { Variant } from '../variant/entities/variant.entity';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockCounts } from './stock';

const NO_STOCK: StockCounts = { onHand: 0, reserved: 0 };

@Injectable({ scope: Scope.REQUEST })
export class VariantStockLoader {
  constructor(private readonly repository: StockLedgerRepository) {}

  /** Stock of each variant summed over locations: one grouped query per request (no N+1). */
  readonly loader = new DataLoader<string, StockCounts>(async (variantIds: readonly string[]) => {
    const levels = await this.repository.findLevelsByVariant(variantIds);
    return variantIds.map((id) => levels.get(id) ?? NO_STOCK);
  });
}

// Variant stock comes from the ledger's StockLevel rows, which live in this module.
@Resolver(() => Variant)
export class VariantStockResolver {
  constructor(private readonly stock: VariantStockLoader) {}

  @ResolveField(() => Int, { description: 'Units that can be bought now: on hand minus reserved for open orders' })
  async available(@Parent() variant: Variant): Promise<number> {
    const { onHand, reserved } = await this.stock.loader.load(variant.id);
    return onHand - reserved;
  }

  @ResolveField(() => Int, {
    description: 'Units physically in stock, including reserved ones (staff with inventory.view)',
    middleware: [staffWith('inventory.view')],
  })
  async onHand(@Parent() variant: Variant): Promise<number> {
    return (await this.stock.loader.load(variant.id)).onHand;
  }

  @ResolveField(() => Int, {
    description: 'Units held for open orders (staff with inventory.view)',
    middleware: [staffWith('inventory.view')],
  })
  async reserved(@Parent() variant: Variant): Promise<number> {
    return (await this.stock.loader.load(variant.id)).reserved;
  }
}
