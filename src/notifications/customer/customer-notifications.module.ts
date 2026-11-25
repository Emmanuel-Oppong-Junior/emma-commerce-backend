import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications.module';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPreferencesResolver } from './notification-preferences.resolver';
import { InAppFeedService } from './in-app-feed.service';
import { InAppFeedResolver } from './in-app-feed.resolver';

/** The customer-facing notification API: preferences and consent, and the in-app feed. */
@Module({
  imports: [NotificationsModule],
  providers: [NotificationPreferencesService, NotificationPreferencesResolver, InAppFeedService, InAppFeedResolver],
  exports: [NotificationPreferencesService],
})
export class CustomerNotificationsModule {}
