import { Injectable, Scope } from '@nestjs/common';
import { Args, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { Lot as LotRow } from '../../generated/prisma/client';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { StockMovement } from '../entities/stock-movement.entity';
import { ExpiringStockArgs } from './dto/expiring-stock.args';
import { ExpiringStockLine, Lot } from './entities/lot.entity';
import { LotWithStock } from './lot-stock.repository';
import { isExpired } from './lots';
import { LotsService } from './lots.service';

function lotView(lot: LotWithStock | LotRow, now: Date): Lot {
  const stock =
    'stock' in lot
      ? lot.stock.map((s) => ({ locationId: s.locationId, locationName: s.location.name, onHand: s.onHand }))
      : [];
  return {
    id: lot.id,
    variantId: lot.variantId,
    lotNumber: lot.lotNumber,
    expiresAt: lot.expiresAt,
    manufacturedAt: lot.manufacturedAt,
    createdAt: lot.createdAt,
    expired: isExpired(lot.expiresAt, now),
    onHand: stock.reduce((sum, s) => sum + s.onHand, 0),
    stock,
  };
}

@Injectable({ scope: Scope.REQUEST })
export class LotLoader {
  constructor(private readonly lots: LotsService) {}

  /** The lots of the movements on a page: one query per request. */
  readonly byId = new DataLoader<string, LotRow | null>(async (ids: readonly string[]) => {
    const found = new Map((await this.lots.findLotsByIds(ids)).map((lot) => [lot.id, lot]));
    return ids.map((id) => found.get(id) ?? null);
  });
}

@Resolver(() => Lot)
export class LotsResolver {
  constructor(private readonly lots: LotsService) {}

  @RequirePermission('inventory.view')
  @Query(() => [ExpiringStockLine], {
    description:
      'Lots with stock expiring within withinDays (default 30, expired ones included), soonest first, with units ' +
      'per location and their value at the current price (staff)',
  })
  expiringStock(@Args() { withinDays, locationId, categoryId }: ExpiringStockArgs): Promise<ExpiringStockLine[]> {
    return this.lots.expiringStock({ withinDays, locationId, categoryId }, new Date());
  }

  @RequirePermission('inventory.view')
  @Query(() => [Lot], { description: 'The lots of a lot-tracked variant, soonest expiry first (staff)' })
  async variantLots(@Args('variantId', { type: () => ID }) variantId: string): Promise<Lot[]> {
    const now = new Date();
    return (await this.lots.variantLots(variantId)).map((lot) => lotView(lot, now));
  }
}

// StockMovement is only reachable through operations that need inventory permissions.
@Resolver(() => StockMovement)
export class StockMovementLotResolver {
  constructor(private readonly loader: LotLoader) {}

  @ResolveField(() => Lot, {
    nullable: true,
    description: 'The lot the units came from or went to (lot-tracked variants); its stock is not listed here',
  })
  async lot(@Parent() movement: StockMovement): Promise<Lot | null> {
    if (!movement.lotId) return null;
    const lot = await this.loader.byId.load(movement.lotId);
    return lot && lotView(lot, new Date());
  }
}
