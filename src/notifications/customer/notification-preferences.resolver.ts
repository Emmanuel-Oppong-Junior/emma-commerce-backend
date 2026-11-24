import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ConsentSource, NotificationCategory } from '../../generated/prisma/client';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  ConsentEventEntity,
  NotificationPreferenceEntity,
  RecordCustomerConsentInput,
  UpdateNotificationPreferenceInput,
} from './notification-preference.entities';

@Resolver()
export class NotificationPreferencesResolver {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Auth(AuthType.Bearer)
  @Query(() => [NotificationPreferenceEntity], {
    description:
      'Every category and channel with its current choice: transactional always on (locked), marketing off until you opt in',
  })
  myNotificationPreferences(@ActiveUser('id') userId: string) {
    return this.preferences.list(userId);
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => [NotificationPreferenceEntity], {
    description:
      'Opt in to or out of a category on a channel; returns every preference. Each marketing change is recorded in the ' +
      'consent ledger. BAD_REQUEST with reason TRANSACTIONAL_ALWAYS_ON (transactional messages cannot be switched off), ' +
      'CHANNEL_NOT_AVAILABLE (marketing is EMAIL and SMS only) or PHONE_NOT_VERIFIED (marketing SMS needs a verified phone)',
  })
  updateNotificationPreference(
    @ActiveUser('id') userId: string,
    @Args('input') input: UpdateNotificationPreferenceInput,
  ) {
    return this.preferences.update(userId, {
      category: input.category,
      channel: input.channel,
      enabled: input.enabled,
      source: input.source ?? ConsentSource.ACCOUNT_SETTINGS,
    });
  }

  @RequirePermission('user.manage')
  @Mutation(() => [NotificationPreferenceEntity], {
    description:
      "Record a customer's request (by phone, in store) to receive or stop marketing on a channel (staff, source " +
      'STAFF_REQUEST); returns their preferences. Same refusals as updateNotificationPreference',
  })
  recordCustomerConsent(@ActiveUser('id') actorId: string, @Args('input') input: RecordCustomerConsentInput) {
    return this.preferences.update(input.userId, {
      category: NotificationCategory.MARKETING,
      channel: input.channel,
      enabled: input.granted,
      source: ConsentSource.STAFF_REQUEST,
      actorId,
    });
  }

  @RequirePermission('user.view')
  @Query(() => [ConsentEventEntity], { description: "A customer's consent ledger, newest first (staff)" })
  customerConsentHistory(@Args('userId', { type: () => ID }) userId: string) {
    return this.preferences.consentHistory(userId);
  }
}
