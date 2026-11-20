import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { MoneyObject } from '../commons/money/money.object';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZoneEntity } from './entities/shipping-zone.entity';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => ShippingZoneEntity)
export class ShippingZonesResolver {
  constructor(private readonly service: ShippingZonesService) {}
  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, { description: 'Create a shipping zone (admin only)' })
  createShippingZone(@ActiveUser('id') actorId: string, @Args('input') input: CreateShippingZoneInput) {
    return this.service.create(input, actorId);
  }
  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, { description: 'Update a shipping zone (admin only)' })
  updateShippingZone(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateShippingZoneInput,
  ) {
    return this.service.update(id, input, actorId);
  }
  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, { description: 'Delete a shipping zone (admin only)' })
  deleteShippingZone(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.delete(id, actorId);
  }
  @RequirePermission('shipping.manage')
  @Query(() => [ShippingZoneEntity], { description: 'Get all shipping zones (admin only)' })
  shippingZones() {
    return this.service.findAll();
  }
  @RequirePermission('shipping.manage')
  @Query(() => ShippingZoneEntity, { description: 'Get a shipping zone by ID (admin only)' })
  shippingZone(@Args('id', { type: () => ID }) id: string) {
    return this.service.findOne(id);
  }

  @Auth(AuthType.None)
  @Query(() => [ShippingZoneEntity], { description: 'Get all active shipping zones (public)' })
  activeShippingZones() {
    return this.service.findActive();
  }
  @Auth(AuthType.Bearer)
  @Query(() => MoneyObject, { description: 'Get the shipping fee for a saved address' })
  getShippingFee(@ActiveUser('id') userId: string, @Args('addressId', { type: () => ID }) addressId: string) {
    return this.service.getFeeForAddress(addressId, userId);
  }
}
