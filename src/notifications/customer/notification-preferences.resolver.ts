import { BadRequestException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { MarketingLinks } from '../marketing-links';
import { ConsentSource, NotificationCategory, NotificationChannel } from '../../generated/prisma/client';
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
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly marketingLinks: MarketingLinks,
  ) {}

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

  @Auth(AuthType.None)
  @Throttle({ auth: { ttl: 60000, limit: 5 } })
  @Mutation(() => Boolean, {
    description:
      'One-click unsubscribe from marketing emails, with the token of the link in a marketing email (no sign-in). ' +
      'Recorded in the consent ledger (source EMAIL_LINK); repeating it changes nothing. BAD_REQUEST with reason ' +
      'INVALID_UNSUBSCRIBE_TOKEN',
  })
  async unsubscribeMarketingEmail(@Args('token') token: string): Promise<boolean> {
    const userId = this.marketingLinks.userIdOf(token);
    if (!userId) {
      throw new BadRequestException({
        message: 'This unsubscribe link is not valid',
        extensions: { reason: 'INVALID_UNSUBSCRIBE_TOKEN' },
      });
    }
    await this.preferences.update(userId, {
      category: NotificationCategory.MARKETING,
      channel: NotificationChannel.EMAIL,
      enabled: false,
      source: ConsentSource.EMAIL_LINK,
    });
    return true;
  }
}
