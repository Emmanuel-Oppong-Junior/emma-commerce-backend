import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationSender } from './notification-sender';
import { EmailService } from './email/email.service';
import { CommonsModule } from '../commons/commons.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SMS_PROVIDER } from './sms/sms-provider.port';
import { SmsSender, smsProviderFrom } from './sms/sms-sender';
import { ReadyForPickupNotifier } from './ready-for-pickup.notifier';
import { DeliveryCodeModule } from '../delivery/code/delivery-code.module';
import { NotificationsRepository } from './notifications.repository';
import { NotificationDispatcher } from './notification-dispatcher';

@Module({
  imports: [CommonsModule, InventoryModule, DeliveryCodeModule],
  providers: [
    NotificationsService,
    NotificationSender,
    EmailService,
    SmsSender,
    ReadyForPickupNotifier,
    NotificationsRepository,
    NotificationDispatcher,
    { provide: SMS_PROVIDER, inject: [ConfigService], useFactory: smsProviderFrom },
  ],
  exports: [NotificationsService, NotificationSender, SmsSender],
})
export class NotificationsModule {}
