import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { SetStoreFeatureInput, StoreFeatureEntity } from './store-features.entities';
import { StoreFeaturesService } from './store-features.service';

/** Store-level feature switches (P8-F). */
@Resolver()
export class StoreFeaturesResolver {
  constructor(private readonly features: StoreFeaturesService) {}

  @Auth(AuthType.None)
  @Query(() => [StoreFeatureEntity], { description: 'Every store-level feature and whether it is on (public)' })
  storeFeatures() {
    return this.features.list();
  }

  @RequirePermission('store.features.manage')
  @RequireStepUp()
  @Mutation(() => StoreFeatureEntity, {
    description:
      'Switch a store-level feature on or off. While off, its operations fail with BAD_REQUEST, reason FEATURE_DISABLED ' +
      'and `feature`; nothing it stored is deleted. CASH_ON_DELIVERY sets the payment method switch. Owner, recent ' +
      'step-up, audited',
  })
  setStoreFeature(@ActiveUser('id') actorId: string, @Args('input') input: SetStoreFeatureInput) {
    return this.features.set(input.key, input.enabled, actorId);
  }
}
