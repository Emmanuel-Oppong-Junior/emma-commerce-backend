import { createHash, createHmac, randomInt } from 'node:crypto';

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_DAILY_SENDS_PER_PHONE = 5;
export const OTP_DAILY_SENDS_PER_ACCOUNT = 10;
export const OTP_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

/** `extensions.reason` values of the phone verification errors. */
export enum PhoneVerificationReason {
  PHONE_REQUIRED = 'PHONE_REQUIRED',
  PHONE_ALREADY_VERIFIED = 'PHONE_ALREADY_VERIFIED',
  OTP_RATE_LIMITED = 'OTP_RATE_LIMITED',
  OTP_INVALID = 'OTP_INVALID',
  OTP_EXPIRED = 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED = 'OTP_ATTEMPTS_EXCEEDED',
  SMS_UNAVAILABLE = 'SMS_UNAVAILABLE',
}

/** Which limit refused a code request. */
export enum OtpLimit {
  COOLDOWN = 'COOLDOWN',
  PHONE_DAILY = 'PHONE_DAILY',
  ACCOUNT_DAILY = 'ACCOUNT_DAILY',
}

export interface PhoneVerificationFields {
  phoneNumber: string | null;
  phoneVerifiedAt: Date | null;
  phoneVerifiedNumber: string | null;
}

/** Six digits, uniformly from the CSPRNG. */
export function generateOtpCode(random: (max: number) => number = (max) => randomInt(max)): string {
  return String(random(1_000_000)).padStart(6, '0');
}

/**
 * The key OTP hashes are made with, derived from MFA_ENCRYPTION_KEY with its own label (as the MFA recovery-code hash
 * key is), so a code read from Redis cannot be brute-forced offline without the server secret.
 */
export function otpHashKey(mfaKey: Buffer): Buffer {
  return createHmac('sha256', mfaKey).update('phone-otp').digest();
}

/** The code bound to the account and phone it was sent for, so it verifies nothing else. */
export function hashOtp(hashKey: Buffer, userId: string, phone: string, code: string): string {
  return createHmac('sha256', hashKey).update(`${userId}:${phone}:${code}`).digest('hex');
}

/** Redis keys hold digests, never the phone number. */
export function otpKeys(userId: string, phone: string) {
  const subject = createHash('sha256').update(`${userId}:${phone}`).digest('hex');
  const phoneDigest = createHash('sha256').update(`phone:${phone}`).digest('hex');
  const accountDigest = createHash('sha256').update(`account:${userId}`).digest('hex');
  return {
    code: `otp:code:${subject}`,
    cooldown: `otp:cooldown:${subject}`,
    phoneDaily: `otp:daily:phone:${phoneDigest}`,
    accountDaily: `otp:daily:account:${accountDigest}`,
  };
}

/** The account's phone when it is verified: verified for exactly the number the account holds now. */
export function verifiedPhoneOf(user: PhoneVerificationFields): string | null {
  const { phoneNumber, phoneVerifiedAt, phoneVerifiedNumber } = user;
  return phoneNumber && phoneVerifiedAt && phoneVerifiedNumber === phoneNumber ? phoneNumber : null;
}
