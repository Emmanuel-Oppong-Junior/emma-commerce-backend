import { Injectable, Scope } from '@nestjs/common';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import * as DataLoader from 'dataloader';
import { Decimal } from '@prisma/client/runtime/client';
import { Variant } from '../../variant/entities/variant.entity';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { COST_VIEWERS_ONLY } from './cost-visibility';
import { CostChange, CostChangePage, CostHistoryArgs, SetVariantCostInput } from './cost-change.entity';
import { VariantCostService } from './variant-cost.service';

@Injectable({ scope: Scope.REQUEST })
export class VariantCostLoader {
  constructor(private readonly costs: VariantCostService) {}

  /** One query per request for every Variant.costPrice in the response. */
  readonly loader = new DataLoader<string, Decimal | null>(async (variantIds: readonly string[]) => {
    const costs = await this.costs.costPrices(variantIds);
    return variantIds.map((id) => costs.get(id) ?? null);
  });
}

@Resolver(() => Variant)
export class VariantCostResolver {
  constructor(private readonly costs: VariantCostLoader) {}

  @ResolveField(() => GraphQLDecimal, {
    ...COST_VIEWERS_ONLY,
    description:
      'Weighted-average unit cost over every location, tax-exclusive, 4 dp; null when unknown (inventory.cost.view)',
  })
  costPrice(@Parent() variant: Variant): Promise<Decimal | null> {
    return this.costs.loader.load(variant.id);
  }
}

@Resolver(() => CostChange)
export class CostHistoryResolver {
  constructor(private readonly costs: VariantCostService) {}

  @RequirePermission('inventory.cost.view')
  @Query(() => CostChangePage, { description: "A variant's cost changes, newest first (staff)" })
  variantCostHistory(@Args() { variantId, first, after }: CostHistoryArgs) {
    return this.costs.history(variantId, first, after);
  }

  @RequirePermission('purchasing.manage', 'inventory.cost.view')
  @Mutation(() => CostChange, {
    description: 'Set or correct the unit cost of a variant by hand, with a reason (staff)',
  })
  setVariantCost(@ActiveUser('id') actorId: string, @Args('input') input: SetVariantCostInput) {
    return this.costs.setManually(input.variantId, input.cost, input.reason, actorId);
  }
}
