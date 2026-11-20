import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationSender } from './notification-sender';
import { EmailService } from './email/email.service';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [NotificationsService, NotificationSender, EmailService],
  exports: [NotificationsService, NotificationSender],
})
export class NotificationsModule {}
