import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { StoreService } from './store.service';
import { StoreSettings } from './entities/store-settings.entity';
import { UpdateStoreSettingsInput } from './dto/update-store-settings.input';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';

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

  @Roles(Role.SUPER_ADMIN)
  @Mutation(() => StoreSettings, { description: 'Change the store settings (super admin only)' })
  updateStoreSettings(@ActiveUser('id') actorId: string, @Args('input') input: UpdateStoreSettingsInput) {
    return this.storeService.updateSettings(input, actorId);
  }
}
