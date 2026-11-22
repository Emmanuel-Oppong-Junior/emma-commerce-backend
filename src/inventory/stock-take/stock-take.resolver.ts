import { Injectable, Scope } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { StockTakeService } from './stock-take.service';
import { StockTakeRepository } from './stock-take.repository';
import {
  StockTake,
  StockTakeLine,
  StockTakeLinePage,
  StockTakePage,
  StockTakeVarianceReport,
} from './entities/stock-take.entity';
import { OpenStockTakeInput } from './dto/open-stock-take.input';
import { RecordStockTakeCountsInput } from './dto/record-stock-take-counts.input';
import { StockTakeLinesArgs, StockTakesArgs } from './dto/stock-take.args';

@Injectable({ scope: Scope.REQUEST })
export class StockTakeLineCountLoader {
  constructor(private readonly repository: StockTakeRepository) {}

  /** Line and counted-line totals of each stock-take: two grouped queries per request (no N+1). */
  readonly loader = new DataLoader<string, { lines: number; counted: number }>(async (ids: readonly string[]) => {
    const counts = await this.repository.lineCounts(ids);
    return ids.map((id) => counts.get(id) ?? { lines: 0, counted: 0 });
  });
}

@Resolver(() => StockTake)
export class StockTakeResolver {
  constructor(
    private readonly service: StockTakeService,
    private readonly counts: StockTakeLineCountLoader,
  ) {}

  @RequirePermission('inventory.adjust')
  @Mutation(() => StockTake, {
    description: 'Open a stock count at a location for a category, a list of variants or everything (admin only)',
  })
  openStockTake(@ActiveUser('id') actorId: string, @Args('input') input: OpenStockTakeInput) {
    return this.service.open(input, actorId);
  }

  @RequirePermission('inventory.adjust')
  @Mutation(() => [StockTakeLine], { description: 'Record counted quantities on an OPEN stock-take (admin only)' })
  recordStockTakeCounts(@ActiveUser('id') actorId: string, @Args('input') input: RecordStockTakeCountsInput) {
    return this.service.recordCounts(input, actorId);
  }

  @RequirePermission('inventory.adjust')
  @Mutation(() => StockTake, { description: 'Close counting on an OPEN stock-take for approval (admin only)' })
  submitStockTake(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.submit(id, actorId);
  }

  @RequirePermission('inventory.stocktake.approve')
  @Mutation(() => StockTake, {
    description: 'Approve a SUBMITTED stock-take: every non-zero variance becomes a STOCK_TAKE adjustment',
  })
  approveStockTake(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.approve(id, actorId);
  }

  @RequirePermission('inventory.stocktake.approve')
  @Mutation(() => StockTake, { description: 'Cancel an OPEN or SUBMITTED stock-take; no stock moves' })
  cancelStockTake(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    return this.service.cancel(id, actorId, reason);
  }

  @RequirePermission('inventory.view')
  @Query(() => StockTakePage, { description: 'Stock-takes, newest first (admin only)' })
  stockTakes(@Args() { status, locationId, first, after }: StockTakesArgs) {
    return this.service.list({ status, locationId }, first, after);
  }

  @RequirePermission('inventory.view')
  @Query(() => StockTake, { description: 'One stock-take (admin only)' })
  stockTake(@Args('id', { type: () => ID }) id: string) {
    return this.service.get(id);
  }

  @RequirePermission('inventory.view')
  @Query(() => StockTakeLinePage, {
    description: 'Lines of a stock-take in SKU order; expected quantities need inventory.stocktake.approve',
  })
  stockTakeLines(@Args() { stockTakeId, counted, first, after }: StockTakeLinesArgs) {
    return this.service.lines(stockTakeId, { counted }, first, after);
  }

  @RequirePermission('inventory.stocktake.approve')
  @Query(() => StockTakeVarianceReport, { description: 'Counted lines with their variance and its value' })
  stockTakeVarianceReport(@Args('id', { type: () => ID }) id: string) {
    return this.service.varianceReport(id);
  }

  @ResolveField(() => Int, { description: 'Variants in the session' })
  async lineCount(@Parent() stockTake: StockTake): Promise<number> {
    return (await this.counts.loader.load(stockTake.id)).lines;
  }

  @ResolveField(() => Int, { description: 'Variants counted so far' })
  async countedCount(@Parent() stockTake: StockTake): Promise<number> {
    return (await this.counts.loader.load(stockTake.id)).counted;
  }
}
