import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../authentication/decorators/auth.decorator';
import { AuthType } from '../authentication/enums/auth-type.enum';
import { ActiveUser } from '../authentication/decorators/active-user.decorator';
import { ActiveSession } from '../authentication/decorators/active-session.decorator';
import { MfaService } from './mfa.service';
import { MfaEnrollment, MfaRecoveryCodes, StepUpResult } from './mfa.entities';

export const MFA_THROTTLE = { mfa: { ttl: 60000, limit: 5 } };

// Open to every signed-in user, so Owners and Managers can enrol while staff operations still refuse them.
@Auth(AuthType.Bearer)
@Throttle(MFA_THROTTLE)
@Resolver(() => MfaEnrollment)
export class MfaResolver {
  constructor(private readonly mfaService: MfaService) {}

  @Mutation(() => MfaEnrollment, {
    description:
      'Start two-factor enrolment: returns a new TOTP secret and otpauth URI (replacing an unconfirmed one). CONFLICT if already enabled.',
  })
  startMfaEnrollment(@ActiveUser('id') userId: string) {
    return this.mfaService.startEnrollment(userId);
  }

  @Mutation(() => MfaRecoveryCodes, {
    description:
      'Finish enrolment with the first code from the authenticator app. Turns two-factor authentication on and returns 10 single-use recovery codes, shown only this once. Counts as a step-up for this session. Audited.',
  })
  async confirmMfaEnrollment(
    @ActiveUser('id') userId: string,
    @ActiveSession() sessionId: string | undefined,
    @Args('code') code: string,
  ) {
    return { recoveryCodes: await this.mfaService.confirmEnrollment(userId, sessionId, code) };
  }

  @Mutation(() => StepUpResult, {
    description:
      'Verify this session with an authenticator or recovery code. Sensitive actions (role changes, refunds, price changes, exports) are then allowed for 10 minutes. Audited.',
  })
  async stepUp(
    @ActiveUser('id') userId: string,
    @ActiveSession() sessionId: string | undefined,
    @Args('code') code: string,
  ) {
    return { validUntil: await this.mfaService.stepUp(userId, sessionId, code) };
  }
}
