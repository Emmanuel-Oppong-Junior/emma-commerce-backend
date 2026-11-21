import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { Variant } from '../variant/entities/variant.entity';
import { PriceChange, PriceChangePage } from './entities/price-change.entity';
import { PriceChangesArgs, PriceHistoryPageArgs } from './dto/price-changes.args';
import { PriceHistoryService } from './price-history.service';

// Price history is catalogue admin data: whoever may read every variant in the admin catalogue may read its history.
@Resolver(() => PriceChange)
export class PriceHistoryResolver {
  constructor(private readonly priceHistoryService: PriceHistoryService) {}

  @RequirePermission('catalog.product.read')
  @Query(() => PriceChangePage, {
    description: 'Admin: price changes, newest first, optionally of one variant or product and within [from, to)',
  })
  priceChanges(@Args() { variantId, productId, from, to, first, after }: PriceChangesArgs) {
    return this.priceHistoryService.getChanges({ variantId, productId, from, to }, first, after);
  }
}

@Resolver(() => Variant)
export class VariantPriceHistoryResolver {
  constructor(private readonly priceHistoryService: PriceHistoryService) {}

  @ResolveField(() => PriceChangePage, {
    description: 'Price changes of this variant, newest first (staff with catalog.product.read)',
    middleware: [staffWith('catalog.product.read')],
  })
  priceHistory(@Parent() variant: Variant, @Args() { first, after }: PriceHistoryPageArgs) {
    return this.priceHistoryService.getChanges({ variantId: variant.id }, first, after);
  }
}
