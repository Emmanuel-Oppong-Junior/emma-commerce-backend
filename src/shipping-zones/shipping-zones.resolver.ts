import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZoneEntity } from './entities/shipping-zone.entity';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver(() => ShippingZoneEntity)
export class ShippingZonesResolver {
  constructor(private readonly service: ShippingZonesService) {}

  @Mutation(() => ShippingZoneEntity, { description: 'Create a shipping zone (admin only)' })
  createShippingZone(@Args('input') input: CreateShippingZoneInput) {
    return this.service.create(input);
  }

  @Mutation(() => ShippingZoneEntity, { description: 'Update a shipping zone (admin only)' })
  updateShippingZone(@Args('id', { type: () => ID }) id: string, @Args('input') input: UpdateShippingZoneInput) {
    return this.service.update(id, input);
  }

  @Mutation(() => ShippingZoneEntity, { description: 'Delete a shipping zone (admin only)' })
  deleteShippingZone(@Args('id', { type: () => ID }) id: string) {
    return this.service.delete(id);
  }

  @Query(() => [ShippingZoneEntity], { description: 'Get all shipping zones (admin only)' })
  shippingZones() {
    return this.service.findAll();
  }

  @Query(() => ShippingZoneEntity, { description: 'Get a shipping zone by ID (admin only)' })
  shippingZone(@Args('id', { type: () => ID }) id: string) {
    return this.service.findOne(id);
  }
}
