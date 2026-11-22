import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PhoneOtpStore } from './phone-otp.store';
import { PhoneVerificationResolver } from './phone-verification.resolver';
import { PhoneVerificationService } from './phone-verification.service';

@Module({
  imports: [CommonsModule, NotificationsModule],
  providers: [PhoneOtpStore, PhoneVerificationService, PhoneVerificationResolver],
})
export class PhoneVerificationModule {}
