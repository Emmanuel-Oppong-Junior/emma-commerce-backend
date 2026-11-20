import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PickupLocationsService } from './pickup-locations.service';
import { PickupLocationEntity } from './entities/pickup-location.entity';
import { CreatePickupLocationInput } from './dto/create-pickup-location.input';
import { UpdatePickupLocationInput } from './dto/update-pickup-location.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => PickupLocationEntity)
export class PickupLocationsResolver {
  constructor(private readonly service: PickupLocationsService) {}

  @RequirePermission('shipping.manage')
  @Mutation(() => PickupLocationEntity, { description: 'Create a pickup location (admin only)' })
  createPickupLocation(@ActiveUser('id') actorId: string, @Args('input') input: CreatePickupLocationInput) {
    return this.service.create(input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => PickupLocationEntity, { description: 'Update a pickup location (admin only)' })
  updatePickupLocation(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePickupLocationInput,
  ) {
    return this.service.update(id, input, actorId);
  }

  @RequirePermission('shipping.manage')
  @Mutation(() => PickupLocationEntity, { description: 'Delete a pickup location (admin only)' })
  deletePickupLocation(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.delete(id, actorId);
  }

  @RequirePermission('shipping.manage')
  @Query(() => [PickupLocationEntity], { description: 'Get all pickup locations (admin only)' })
  pickupLocations() {
    return this.service.findAll();
  }

  @Auth(AuthType.None)
  @Query(() => [PickupLocationEntity], { description: 'Get all active pickup locations (public)' })
  activePickupLocations() {
    return this.service.findActive();
  }
}
