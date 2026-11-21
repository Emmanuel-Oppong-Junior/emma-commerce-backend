import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { PriceListsService } from './price-lists.service';
import { PriceList, PriceListEntryPage } from './entities/price-list.entity';
import {
  CreatePriceListInput,
  PriceListEntriesArgs,
  PriceListsArgs,
  RemovePriceListEntriesInput,
  SetPriceListEntriesInput,
  UpdatePriceListInput,
} from './dto/price-list.input';

// Every change can move what members pay, so all of them need a recent step-up, like promotion changes.
@Resolver(() => PriceList)
export class PriceListsResolver {
  constructor(private readonly priceListsService: PriceListsService) {}

  @RequirePermission('pricelist.manage')
  @Query(() => [PriceList], { description: 'Admin: price lists, newest first' })
  priceLists(@Args() filter: PriceListsArgs) {
    return this.priceListsService.findAll(filter);
  }

  @RequirePermission('pricelist.manage')
  @Query(() => PriceList, { description: 'Admin: one price list' })
  priceList(@Args('id', { type: () => ID }) id: string) {
    return this.priceListsService.findOne(id);
  }

  @ResolveField(() => PriceListEntryPage, {
    description: 'The entries, by variant id',
    middleware: [staffWith('pricelist.manage')],
  })
  entries(@Parent() list: PriceList, @Args() { first, after }: PriceListEntriesArgs) {
    return this.priceListsService.getEntries(list.id, first, after);
  }

  @RequirePermission('pricelist.manage')
  @RequireStepUp()
  @Mutation(() => PriceList, { description: 'Admin: create a price list in the store currency' })
  createPriceList(@ActiveUser('id') actorId: string, @Args('input') input: CreatePriceListInput) {
    return this.priceListsService.create(input, actorId);
  }

  @RequirePermission('pricelist.manage')
  @RequireStepUp()
  @Mutation(() => PriceList, { description: 'Admin: change a price list' })
  updatePriceList(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePriceListInput,
  ) {
    return this.priceListsService.update(id, input, actorId);
  }

  @RequirePermission('pricelist.manage')
  @RequireStepUp()
  @Mutation(() => PriceList, { description: 'Admin: delete a price list and its entries (orders keep their prices)' })
  deletePriceList(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.priceListsService.delete(id, actorId);
  }

  @RequirePermission('pricelist.manage')
  @RequireStepUp()
  @Mutation(() => PriceList, {
    description: "Admin: set variants' prices in a price list; each entry replaces the variant's entry and tiers",
  })
  setPriceListEntries(@ActiveUser('id') actorId: string, @Args('input') input: SetPriceListEntriesInput) {
    return this.priceListsService.setEntries(input, actorId);
  }

  @RequirePermission('pricelist.manage')
  @RequireStepUp()
  @Mutation(() => PriceList, { description: 'Admin: take variants out of a price list (unknown ones are ignored)' })
  removePriceListEntries(@ActiveUser('id') actorId: string, @Args('input') input: RemovePriceListEntriesInput) {
    return this.priceListsService.removeEntries(input, actorId);
  }
}
