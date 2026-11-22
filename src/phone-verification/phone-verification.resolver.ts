import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { PhoneVerificationService } from './phone-verification.service';
import {
  PhoneVerificationRequest,
  PhoneVerificationStatusEntity,
  VerifyPhoneInput,
} from './phone-verification.entities';

@Auth(AuthType.Bearer)
@Resolver()
export class PhoneVerificationResolver {
  constructor(private readonly phoneVerification: PhoneVerificationService) {}

  @Query(() => PhoneVerificationStatusEntity, {
    description: "Whether the current user's phone number is verified (cash on delivery needs it)",
  })
  myPhoneVerification(@ActiveUser('id') userId: string) {
    return this.phoneVerification.status(userId);
  }

  @Mutation(() => PhoneVerificationRequest, {
    description:
      "Text a 6-digit code to the current user's phone number (valid 10 minutes, replacing an earlier one). BAD_REQUEST " +
      'with reason PHONE_REQUIRED (no number on the profile), PHONE_ALREADY_VERIFIED, or OTP_RATE_LIMITED (limit: ' +
      'COOLDOWN 60 s between codes, PHONE_DAILY 5 per number or ACCOUNT_DAILY 10 per account a day; retryAfterSeconds)',
  })
  requestPhoneVerification(@ActiveUser('id') userId: string) {
    return this.phoneVerification.requestCode(userId);
  }

  @Throttle({ auth: { ttl: 60000, limit: 5 } })
  @Mutation(() => PhoneVerificationStatusEntity, {
    description:
      'Confirm the phone number with the code from the SMS. BAD_REQUEST with reason OTP_INVALID (attemptsRemaining), ' +
      'OTP_ATTEMPTS_EXCEEDED (5 wrong codes: the code is dead) or OTP_EXPIRED (none live: request a new one)',
  })
  verifyPhone(@ActiveUser('id') userId: string, @Args('input') input: VerifyPhoneInput) {
    return this.phoneVerification.verifyCode(userId, input.code);
  }
}
