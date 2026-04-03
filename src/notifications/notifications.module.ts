import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email/email.service';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [NotificationsService, EmailService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
