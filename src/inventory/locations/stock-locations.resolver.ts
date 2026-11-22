import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';
import { ShippingZoneEntity } from '../../shipping-zones/entities/shipping-zone.entity';
import { PickupLocationEntity } from '../../pickup-locations/entities/pickup-location.entity';
import { StockLocation } from './stock-location.entity';
import { CreateStockLocationInput, FulfilmentLocationsInput, UpdateStockLocationInput } from './stock-location.input';
import { StockLocationsService } from './stock-locations.service';

@Resolver(() => StockLocation)
export class StockLocationsResolver {
  constructor(private readonly locations: StockLocationsService) {}

  @RequirePermission('inventory.view')
  @Query(() => [StockLocation], { description: 'Every stock location, the default first (staff)' })
  stockLocations() {
    return this.locations.findAll();
  }

  @RequirePermission('inventory.view')
  @Query(() => StockLocation, { description: 'A stock location (staff)' })
  stockLocation(@Args('id', { type: () => ID }) id: string) {
    return this.locations.findOne(id);
  }

  @RequirePermission('inventory.location.manage')
  @Mutation(() => StockLocation, { description: 'Create a stock location (staff)' })
  createStockLocation(@ActiveUser('id') actorId: string, @Args('input') input: CreateStockLocationInput) {
    return this.locations.create(input, actorId);
  }

  @RequirePermission('inventory.location.manage')
  @Mutation(() => StockLocation, {
    description: 'Rename, retype, (de)activate a stock location or make it the default (staff)',
  })
  updateStockLocation(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateStockLocationInput,
  ) {
    return this.locations.update(id, input, actorId);
  }

  @RequirePermission('inventory.location.manage')
  @Mutation(() => StockLocation, {
    description: 'Delete a stock location that never held stock; deactivate one with history instead (staff)',
  })
  deleteStockLocation(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.locations.delete(id, actorId);
  }

  @RequirePermission('inventory.location.manage')
  @Mutation(() => [StockLocation], {
    description: 'Set the locations that fulfil deliveries to a shipping zone, first tried first (staff)',
  })
  setShippingZoneFulfilmentLocations(
    @ActiveUser('id') actorId: string,
    @Args('shippingZoneId', { type: () => ID }) shippingZoneId: string,
    @Args('input') input: FulfilmentLocationsInput,
  ) {
    return this.locations.setFulfilmentLocations({ shippingZoneId }, input.locationIds, actorId);
  }

  @RequirePermission('inventory.location.manage')
  @Mutation(() => [StockLocation], {
    description: 'Set the locations that fulfil orders collected at a pickup point, first tried first (staff)',
  })
  setPickupLocationFulfilmentLocations(
    @ActiveUser('id') actorId: string,
    @Args('pickupLocationId', { type: () => ID }) pickupLocationId: string,
    @Args('input') input: FulfilmentLocationsInput,
  ) {
    return this.locations.setFulfilmentLocations({ pickupLocationId }, input.locationIds, actorId);
  }
}

// Fulfilment lists are inventory data, so their fields live here rather than in the shipping modules.
@Resolver(() => ShippingZoneEntity)
export class ShippingZoneFulfilmentResolver {
  constructor(private readonly locations: StockLocationsService) {}

  @ResolveField(() => [StockLocation], {
    description: 'Locations that fulfil deliveries here, first tried first; empty = the default (inventory.view)',
    middleware: [staffWith('inventory.view')],
  })
  fulfilmentLocations(@Parent() zone: ShippingZoneEntity) {
    return this.locations.fulfilmentLocations({ shippingZoneId: zone.id });
  }
}

@Resolver(() => PickupLocationEntity)
export class PickupLocationFulfilmentResolver {
  constructor(private readonly locations: StockLocationsService) {}

  @ResolveField(() => [StockLocation], {
    description: 'Locations that fulfil orders collected here, first tried first; empty = the default (inventory.view)',
    middleware: [staffWith('inventory.view')],
  })
  fulfilmentLocations(@Parent() pickup: PickupLocationEntity) {
    return this.locations.fulfilmentLocations({ pickupLocationId: pickup.id });
  }
}
