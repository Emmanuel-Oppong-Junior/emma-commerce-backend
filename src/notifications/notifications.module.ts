import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationSender } from './notification-sender';
import { EmailService } from './email/email.service';
import { CommonsModule } from '../commons/commons.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SMS_PROVIDER } from './sms/sms-provider.port';
import { SmsSender, smsProviderFrom } from './sms/sms-sender';

@Module({
  imports: [CommonsModule, InventoryModule],
  providers: [
    NotificationsService,
    NotificationSender,
    EmailService,
    SmsSender,
    { provide: SMS_PROVIDER, inject: [ConfigService], useFactory: smsProviderFrom },
  ],
  exports: [NotificationsService, NotificationSender, SmsSender],
})
export class NotificationsModule {}
