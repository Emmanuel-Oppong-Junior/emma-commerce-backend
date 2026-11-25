import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { hashOtp, OtpLimit, otpHashKey } from './phone-otp';
import { PhoneVerificationService } from './phone-verification.service';

const MFA_KEY = 'ab'.repeat(32);
const PHONE = '+233244123456';

function setup(user: object | null = { phoneNumber: PHONE, phoneVerifiedAt: null, phoneVerifiedNumber: null }) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const store = { issue: jest.fn().mockResolvedValue({ issued: true }), verify: jest.fn() };
  const notifications = { queuePhoneOtpSms: jest.fn().mockResolvedValue(undefined) };
  const sms = { canSend: true };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const config = { getOrThrow: () => MFA_KEY };
  const service = new PhoneVerificationService(
    prisma as never,
    store as never,
    notifications as never,
    sms as never,
    logger as never,
    config as never,
  );
  return { service, prisma, store, notifications, sms, logger };
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { extensions: Record<string, unknown> }).extensions;
}

describe('PhoneVerificationService', () => {
  describe('requestCode', () => {
    it('stores the hash of a 6-digit code and queues the SMS with that code', async () => {
      const { service, store, notifications } = setup();

      await expect(service.requestCode('u1')).resolves.toEqual({
        phoneLast3: '456',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });

      const [userId, to, code, minutes] = notifications.queuePhoneOtpSms.mock.calls[0] as [
        string,
        string,
        string,
        number,
      ];
      expect([userId, to, minutes]).toEqual(['u1', PHONE, 10]);
      expect(code).toMatch(/^\d{6}$/);
      expect(store.issue).toHaveBeenCalledWith(
        'u1',
        PHONE,
        hashOtp(otpHashKey(Buffer.from(MFA_KEY, 'hex')), 'u1', PHONE, code),
      );
    });

    it('never logs the code or the phone number', async () => {
      const { service, logger, notifications } = setup();
      await service.requestCode('u1');
      const code = notifications.queuePhoneOtpSms.mock.calls[0][2] as string;
      const logged = JSON.stringify(logger.log.mock.calls);
      expect(logged).not.toContain(code);
      expect(logged).not.toContain('244123456');
    });

    it('refuses an account without a phone number', async () => {
      const { service } = setup({ phoneNumber: null, phoneVerifiedAt: null, phoneVerifiedNumber: null });
      await expect(reasonOf(service.requestCode('u1'))).resolves.toEqual({ reason: 'PHONE_REQUIRED' });
    });

    it('refuses a phone that is verified already', async () => {
      const { service, store } = setup({ phoneNumber: PHONE, phoneVerifiedAt: new Date(), phoneVerifiedNumber: PHONE });
      await expect(reasonOf(service.requestCode('u1'))).resolves.toEqual({ reason: 'PHONE_ALREADY_VERIFIED' });
      expect(store.issue).not.toHaveBeenCalled();
    });

    it('sends again for a number changed since an earlier verification', async () => {
      const { service, store } = setup({
        phoneNumber: PHONE,
        phoneVerifiedAt: new Date(),
        phoneVerifiedNumber: '+233200000000',
      });
      await service.requestCode('u1');
      expect(store.issue).toHaveBeenCalled();
    });

    it.each([OtpLimit.COOLDOWN, OtpLimit.PHONE_DAILY, OtpLimit.ACCOUNT_DAILY])(
      'answers OTP_RATE_LIMITED for the %s limit and sends nothing',
      async (limit) => {
        const { service, store, notifications } = setup();
        store.issue.mockResolvedValue({ issued: false, limit, retryAfterSeconds: 37 });

        await expect(reasonOf(service.requestCode('u1'))).resolves.toEqual({
          reason: 'OTP_RATE_LIMITED',
          limit,
          retryAfterSeconds: 37,
        });
        expect(notifications.queuePhoneOtpSms).not.toHaveBeenCalled();
      },
    );

    it('is unavailable when SMS cannot be sent (production without a provider)', async () => {
      const { service, sms, store } = setup();
      sms.canSend = false;
      await expect(service.requestCode('u1')).rejects.toThrow(ServiceUnavailableException);
      expect(store.issue).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode', () => {
    it('marks the phone verified on the matching code, only while the account still has that phone', async () => {
      const { service, store, prisma } = setup();
      store.verify.mockResolvedValue({ result: 'MATCH' });

      const result = await service.verifyCode('u1', '123456');

      expect(result.phoneVerified).toBe(true);
      expect(store.verify).toHaveBeenCalledWith(
        'u1',
        PHONE,
        hashOtp(otpHashKey(Buffer.from(MFA_KEY, 'hex')), 'u1', PHONE, '123456'),
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', phoneNumber: PHONE },
        data: { phoneVerifiedAt: result.phoneVerifiedAt, phoneVerifiedNumber: PHONE },
      });
    });

    it('refuses when the phone changed between the check and the write', async () => {
      const { service, store, prisma } = setup();
      store.verify.mockResolvedValue({ result: 'MATCH' });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(reasonOf(service.verifyCode('u1', '123456'))).resolves.toEqual({ reason: 'OTP_EXPIRED' });
    });

    it.each([
      [
        { result: 'MISMATCH', attemptsLeft: 2 },
        { reason: 'OTP_INVALID', attemptsRemaining: 2 },
      ],
      [{ result: 'ATTEMPTS_EXCEEDED' }, { reason: 'OTP_ATTEMPTS_EXCEEDED' }],
      [{ result: 'NO_CODE' }, { reason: 'OTP_EXPIRED' }],
    ])('answers %p with %p and writes nothing', async (outcome, extensions) => {
      const { service, store, prisma } = setup();
      store.verify.mockResolvedValue(outcome);
      await expect(reasonOf(service.verifyCode('u1', '000000'))).resolves.toEqual(extensions);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('reports a verified phone with its date, and a changed one as not verified', async () => {
      const at = new Date('2026-11-22T10:00:00Z');
      await expect(
        setup({ phoneNumber: PHONE, phoneVerifiedAt: at, phoneVerifiedNumber: PHONE }).service.status('u1'),
      ).resolves.toEqual({ phoneVerified: true, phoneVerifiedAt: at });
      await expect(
        setup({ phoneNumber: PHONE, phoneVerifiedAt: at, phoneVerifiedNumber: '+233200000000' }).service.status('u1'),
      ).resolves.toEqual({ phoneVerified: false, phoneVerifiedAt: null });
    });
  });
});
