import { phoneOtpText } from '../notifications/sms/sms-jobs';
import { generateOtpCode, hashOtp, otpHashKey, otpKeys, verifiedPhoneOf } from './phone-otp';

describe('phone OTP', () => {
  const key = otpHashKey(Buffer.alloc(32, 7));

  describe('generateOtpCode', () => {
    it('draws one of a million codes and pads it to 6 digits', () => {
      const random = jest.fn().mockReturnValue(42);
      expect(generateOtpCode(random)).toBe('000042');
      expect(random).toHaveBeenCalledWith(1_000_000);
      expect(generateOtpCode(() => 999_999)).toBe('999999');
    });

    it('uses the CSPRNG by default', () => {
      const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
      for (const code of codes) expect(code).toMatch(/^\d{6}$/);
      expect(codes.size).toBeGreaterThan(40);
    });
  });

  describe('hashOtp', () => {
    it('is stable for the same account, phone and code', () => {
      expect(hashOtp(key, 'u1', '+233244123456', '123456')).toBe(hashOtp(key, 'u1', '+233244123456', '123456'));
    });

    it('differs for another code, phone, account or key', () => {
      const base = hashOtp(key, 'u1', '+233244123456', '123456');
      expect(hashOtp(key, 'u1', '+233244123456', '123457')).not.toBe(base);
      expect(hashOtp(key, 'u1', '+233244123457', '123456')).not.toBe(base);
      expect(hashOtp(key, 'u2', '+233244123456', '123456')).not.toBe(base);
      expect(hashOtp(otpHashKey(Buffer.alloc(32, 8)), 'u1', '+233244123456', '123456')).not.toBe(base);
    });

    it('never contains the code', () => {
      expect(hashOtp(key, 'u1', '+233244123456', '123456')).not.toContain('123456');
    });
  });

  describe('otpKeys', () => {
    it('hold digests, never the phone number', () => {
      const keys = otpKeys('u1', '+233244123456');
      for (const value of Object.values(keys)) expect(value).not.toContain('244123456');
    });

    it('share the phone counter across accounts and the account counter across phones', () => {
      expect(otpKeys('u1', '+233244123456').phoneDaily).toBe(otpKeys('u2', '+233244123456').phoneDaily);
      expect(otpKeys('u1', '+233244123456').accountDaily).toBe(otpKeys('u1', '+233200000000').accountDaily);
      expect(otpKeys('u1', '+233244123456').code).not.toBe(otpKeys('u2', '+233244123456').code);
    });
  });

  describe('verifiedPhoneOf', () => {
    const verified = {
      phoneNumber: '+233244123456',
      phoneVerifiedAt: new Date(),
      phoneVerifiedNumber: '+233244123456',
    };

    it('is the phone when the current number was verified', () => {
      expect(verifiedPhoneOf(verified)).toBe('+233244123456');
    });

    it('is null once the phone number changed', () => {
      expect(verifiedPhoneOf({ ...verified, phoneNumber: '+233200000000' })).toBeNull();
    });

    it('is null without a verification or without a phone', () => {
      expect(verifiedPhoneOf({ ...verified, phoneVerifiedAt: null })).toBeNull();
      expect(verifiedPhoneOf({ phoneNumber: null, phoneVerifiedAt: null, phoneVerifiedNumber: null })).toBeNull();
    });
  });

  it('keeps the SMS within one 160-character segment', () => {
    const text = phoneOtpText('123456', 10);
    expect(text).toContain('123456');
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(/^[\x20-\x7E]+$/);
  });
});
