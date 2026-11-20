import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/** Values of `extensions.reason` on FORBIDDEN / UNAUTHENTICATED errors, for the frontend to branch on. */
export const MFA_ENROLLMENT_REQUIRED = 'MFA_ENROLLMENT_REQUIRED';
export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
export const MFA_REQUIRED = 'MFA_REQUIRED';

export function mfaEnrollmentRequired(): ForbiddenException {
  return new ForbiddenException({
    message: 'Your staff role requires two-factor authentication: enrol with startMfaEnrollment first',
    extensions: { reason: MFA_ENROLLMENT_REQUIRED },
  });
}

export function stepUpRequired(): ForbiddenException {
  return new ForbiddenException({
    message: 'This action needs a two-factor verification in the last 10 minutes: call stepUp first',
    extensions: { reason: STEP_UP_REQUIRED },
  });
}

/** signIn for an account with two-factor authentication: carries the challenge completeMfaSignIn needs. */
export function mfaRequired(mfaChallenge: string): UnauthorizedException {
  return new UnauthorizedException({
    message: 'Two-factor authentication required: complete sign-in with completeMfaSignIn',
    extensions: { reason: MFA_REQUIRED, mfaChallenge },
  });
}
