import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { StoreService } from './store.service';
import { StoreSettings } from './entities/store-settings.entity';
import { UpdateStoreSettingsInput } from './dto/update-store-settings.input';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => StoreSettings)
export class StoreResolver {
  constructor(private readonly storeService: StoreService) {}

  @Auth(AuthType.None)
  @Query(() => StoreSettings, {
    description: 'The store settings: names, tax registration, currency, contact (public)',
  })
  storeSettings() {
    return this.storeService.getSettings();
  }

  @RequirePermission('store.settings.manage')
  @Mutation(() => StoreSettings, { description: 'Change the store settings (super admin only)' })
  updateStoreSettings(@ActiveUser('id') actorId: string, @Args('input') input: UpdateStoreSettingsInput) {
    return this.storeService.updateSettings(input, actorId);
  }
}
