import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmsSender } from '../notifications/sms/sms-sender';
import { parseMfaKey } from '../iam/mfa/mfa-crypto';
import { PhoneOtpStore } from './phone-otp.store';
import {
  generateOtpCode,
  hashOtp,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  otpHashKey,
  PhoneVerificationFields,
  PhoneVerificationReason as Reason,
  verifiedPhoneOf,
} from './phone-otp';

const CONTEXT = 'PhoneVerification';

export interface PhoneVerificationRequestResult {
  /** Last 3 digits of the number the code was sent to. */
  phoneLast3: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface PhoneVerificationStatus {
  phoneVerified: boolean;
  phoneVerifiedAt: Date | null;
}

function refusal(reason: Reason, message: string, extra: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ message, extensions: { reason, ...extra } });
}

/**
 * Verifies the account's phone number with a one-time SMS code (P3-B.1, ADR-0015), which cash on delivery requires.
 * Codes live hashed in Redis (PhoneOtpStore) and the SMS goes out from the worker; the code and the full number are
 * never logged.
 */
@Injectable()
export class PhoneVerificationService {
  private readonly hashKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PhoneOtpStore,
    private readonly notifications: NotificationsService,
    private readonly sms: SmsSender,
    private readonly logger: LoggerService,
    config: ConfigService,
  ) {
    this.hashKey = otpHashKey(parseMfaKey(config.getOrThrow<string>('MFA_ENCRYPTION_KEY')));
  }

  async status(userId: string): Promise<PhoneVerificationStatus> {
    return statusOf(await this.findUser(userId));
  }

  /** Sends a new code to the account's phone, unless it is verified already or a send limit refuses it. */
  async requestCode(userId: string): Promise<PhoneVerificationRequestResult> {
    const user = await this.findUser(userId);
    const phone = this.phoneToVerify(user);
    if (!this.sms.canSend) {
      throw new ServiceUnavailableException({
        message: 'Phone verification is unavailable: SMS is not configured',
        extensions: { reason: Reason.SMS_UNAVAILABLE },
      });
    }
    const code = generateOtpCode();
    const outcome = await this.store.issue(userId, phone, hashOtp(this.hashKey, userId, phone, code));
    if (!outcome.issued) {
      throw refusal(
        Reason.OTP_RATE_LIMITED,
        `Too many verification codes requested; try again in ${outcome.retryAfterSeconds} seconds`,
        { limit: outcome.limit, retryAfterSeconds: outcome.retryAfterSeconds },
      );
    }
    await this.notifications.queuePhoneOtpSms(phone, code, OTP_TTL_SECONDS / 60);
    this.logger.log(`Phone verification code queued | userId: ${userId}`, CONTEXT);
    return {
      phoneLast3: phone.slice(-3),
      expiresInSeconds: OTP_TTL_SECONDS,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    };
  }

  /** Marks the account's phone verified when `code` is the live code sent to it. */
  async verifyCode(userId: string, code: string): Promise<PhoneVerificationStatus> {
    const user = await this.findUser(userId);
    const phone = this.phoneToVerify(user);
    const outcome = await this.store.verify(userId, phone, hashOtp(this.hashKey, userId, phone, code));
    switch (outcome.result) {
      case 'NO_CODE':
        throw refusal(Reason.OTP_EXPIRED, 'No valid verification code for this phone number; request a new one');
      case 'ATTEMPTS_EXCEEDED':
        throw refusal(Reason.OTP_ATTEMPTS_EXCEEDED, `Wrong code entered ${OTP_MAX_ATTEMPTS} times; request a new one`);
      case 'MISMATCH':
        throw refusal(Reason.OTP_INVALID, 'Wrong verification code', { attemptsRemaining: outcome.attemptsLeft });
      case 'MATCH':
        break;
    }
    const verifiedAt = new Date();
    // Conditional on the number, so a phone changed since the code was sent is not marked verified.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, phoneNumber: phone },
      data: { phoneVerifiedAt: verifiedAt, phoneVerifiedNumber: phone },
    });
    if (count === 0) {
      throw refusal(Reason.OTP_EXPIRED, 'The phone number changed since the code was sent; request a new one');
    }
    this.logger.log(`Phone verified | userId: ${userId}`, CONTEXT);
    return { phoneVerified: true, phoneVerifiedAt: verifiedAt };
  }

  private phoneToVerify(user: PhoneVerificationFields): string {
    const phone = user.phoneNumber;
    if (!phone) {
      throw refusal(Reason.PHONE_REQUIRED, 'Add a phone number to your profile (updateMyProfile) before verifying it');
    }
    if (verifiedPhoneOf(user)) throw refusal(Reason.PHONE_ALREADY_VERIFIED, 'This phone number is already verified');
    return phone;
  }

  private async findUser(userId: string): Promise<PhoneVerificationFields> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedNumber: true },
    });
    if (!user) throw new NotFoundException(`User "${userId}" not found`);
    return user;
  }
}

export function statusOf(user: PhoneVerificationFields): PhoneVerificationStatus {
  return verifiedPhoneOf(user)
    ? { phoneVerified: true, phoneVerifiedAt: user.phoneVerifiedAt }
    : { phoneVerified: false, phoneVerifiedAt: null };
}
