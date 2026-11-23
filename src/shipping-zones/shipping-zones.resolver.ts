import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ShippingZonesService } from './shipping-zones.service';
import { RateRuleEntity, ShippingZoneEntity } from './entities/shipping-zone.entity';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { CreateRateRuleInput, UpdateRateRuleInput } from './dto/rate-rule.input';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';

@Resolver(() => ShippingZoneEntity)
export class ShippingZonesResolver {
  constructor(private readonly service: ShippingZonesService) {}

  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, {
    description: 'Create a shipping zone from regions, towns and areas; add its fees with createRateRule. Audited',
  })
  createShippingZone(@ActiveUser('id') actorId: string, @Args('input') input: CreateShippingZoneInput) {
    return this.service.create(input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, { description: 'Update a shipping zone (areas are replaced). Audited' })
  updateShippingZone(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateShippingZoneInput,
  ) {
    return this.service.update(id, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => ShippingZoneEntity, { description: 'Delete a shipping zone with its areas and rate rules. Audited' })
  deleteShippingZone(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.delete(id, actorId);
  }

  @RequirePermission('shipping.manage')
  @RequireStepUp()
  @Mutation(() => RateRuleEntity, {
    description: 'Add a delivery fee for a service level to a zone. A price change: recent step-up; audited',
  })
  createRateRule(
    @ActiveUser('id') actorId: string,
    @Args('zoneId', { type: () => ID }) zoneId: string,
    @Args('input') input: CreateRateRuleInput,
  ) {
    return this.service.createRateRule(zoneId, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @RequireStepUp()
  @Mutation(() => RateRuleEntity, {
    description: "Change a rate rule's fees, weight bands or active flag. A price change: recent step-up; audited",
  })
  updateRateRule(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateRateRuleInput,
  ) {
    return this.service.updateRateRule(id, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @RequireStepUp()
  @Mutation(() => RateRuleEntity, { description: 'Delete a rate rule. A price change: recent step-up; audited' })
  deleteRateRule(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.deleteRateRule(id, actorId);
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
  @Query(() => [ShippingZoneEntity], {
    description: 'Active shipping zones with their areas and active rate rules (public rate card)',
  })
  activeShippingZones() {
    return this.service.findActive();
  }
}
