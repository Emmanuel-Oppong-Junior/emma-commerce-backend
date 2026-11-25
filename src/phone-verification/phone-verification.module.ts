import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GuestOrderClaimsModule } from '../guest-checkout/guest-order-claims.service';
import { PhoneOtpStore } from './phone-otp.store';
import { PhoneVerificationResolver } from './phone-verification.resolver';
import { PhoneVerificationService } from './phone-verification.service';

@Module({
  imports: [CommonsModule, NotificationsModule, GuestOrderClaimsModule],
  providers: [PhoneOtpStore, PhoneVerificationService, PhoneVerificationResolver],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
