import { Module } from '@nestjs/common';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPreferencesResolver } from './notification-preferences.resolver';

/** The customer-facing notification API: preferences and consent. */
@Module({
  providers: [NotificationPreferencesService, NotificationPreferencesResolver],
  exports: [NotificationPreferencesService],
})
export class CustomerNotificationsModule {}
