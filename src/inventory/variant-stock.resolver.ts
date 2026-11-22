import { Injectable, Scope } from '@nestjs/common';
import { Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { Variant } from '../variant/entities/variant.entity';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { StockLedgerRepository } from './stock-ledger.repository';
import { StockCounts } from './stock';
import { LocationStockLevel, StockLocationsRepository } from './locations/stock-locations.repository';
import { VariantStockLevel } from './locations/stock-location.entity';

const NO_STOCK: StockCounts = { onHand: 0, reserved: 0 };

@Injectable({ scope: Scope.REQUEST })
export class VariantStockLoader {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly locations: StockLocationsRepository,
  ) {}

  /** Stock of each variant summed over locations: one grouped query per request (no N+1). */
  readonly loader = new DataLoader<string, StockCounts>(async (variantIds: readonly string[]) => {
    const levels = await this.repository.findLevelsByVariant(variantIds);
    return variantIds.map((id) => levels.get(id) ?? NO_STOCK);
  });

  /** What a customer can buy of each variant in one order (the best serving location): one query per request. */
  readonly sellable = new DataLoader<string, number>(async (variantIds: readonly string[]) => {
    const sellable = await this.locations.findSellable(variantIds);
    return variantIds.map((id) => sellable.get(id) ?? 0);
  });

  readonly byLocation = new DataLoader<string, LocationStockLevel[]>(async (variantIds: readonly string[]) => {
    const levels = await this.locations.findLevelsByLocation(variantIds);
    return variantIds.map((id) => levels.filter((level) => level.variantId === id));
  });
}

// Variant stock comes from the ledger's StockLevel rows, which live in this module.
@Resolver(() => Variant)
export class VariantStockResolver {
  constructor(private readonly stock: VariantStockLoader) {}

  @ResolveField(() => Int, {
    description:
      'Units that can be bought now in one order: on hand minus reserved, at the best single location that serves ' +
      'customers (an order is fulfilled from one location)',
  })
  async available(@Parent() variant: Variant): Promise<number> {
    return this.stock.sellable.load(variant.id);
  }

  @ResolveField(() => Int, {
    description: 'Units physically in stock at every location, including reserved ones (staff with inventory.view)',
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

  @ResolveField(() => [VariantStockLevel], {
    description: 'Stock at each location, the default first (staff with inventory.view)',
    middleware: [staffWith('inventory.view')],
  })
  async stockLevels(@Parent() variant: Variant): Promise<VariantStockLevel[]> {
    const levels = await this.stock.byLocation.load(variant.id);
    return levels.map((level) => ({ ...level, available: level.onHand - level.reserved }));
  }
}
