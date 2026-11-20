import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { hashRecoveryCode, openSecret, parseMfaKey, sealSecret } from './mfa-crypto';
import { base32Decode, hotp, timeStep } from './totp';
import { STEP_UP_WINDOW_MS } from './step-up.store';
import { AUDIT_TX, createAuditServiceMock } from '../../../test/helpers/audit.helper';
import { TEST_TOTP_SEED } from '../../../test/helpers/staff.helper';

const KEY_HEX = 'cd'.repeat(32);
const KEY = parseMfaKey(KEY_HEX);
const SEED = base32Decode(TEST_TOTP_SEED);

describe('MfaService', () => {
  const repository = {
    findMfaState: jest.fn(),
    findIssuerName: jest.fn(),
    savePendingSecret: jest.fn(),
    claimTimeStep: jest.fn(),
    consumeRecoveryCode: jest.fn(),
    enable: jest.fn(),
  };
  const stepUpStore = { markVerified: jest.fn() };
  const config = { getOrThrow: jest.fn(() => KEY_HEX) };
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: MfaService;

  const enabledState = (overrides: object = {}) => ({
    id: 'u1',
    email: 'staff@example.com',
    mfaSecret: sealSecret(KEY, TEST_TOTP_SEED, 'u1'),
    mfaEnabledAt: new Date(),
    mfaLastUsedStep: null,
    ...overrides,
  });
  const currentCode = () => hotp(SEED, timeStep(Date.now()));

  beforeEach(() => {
    jest.clearAllMocks();
    audit = createAuditServiceMock();
    service = new MfaService(repository as never, stepUpStore as never, audit as never, config as never);
    repository.claimTimeStep.mockResolvedValue(true);
    repository.consumeRecoveryCode.mockResolvedValue(true);
    repository.savePendingSecret.mockResolvedValue(true);
    repository.enable.mockResolvedValue(true);
    repository.findIssuerName.mockResolvedValue('Ama Shop');
  });

  it('fails at startup without a valid MFA_ENCRYPTION_KEY', () => {
    expect(
      () =>
        new MfaService(
          repository as never,
          stepUpStore as never,
          audit as never,
          { getOrThrow: () => 'short' } as never,
        ),
    ).toThrow('MFA_ENCRYPTION_KEY must be 64 hexadecimal characters');
  });

  describe('startEnrollment', () => {
    it('stores a new secret encrypted for the user and returns it with the otpauth URI', async () => {
      repository.findMfaState.mockResolvedValue(enabledState({ mfaEnabledAt: null, mfaSecret: null }));

      const { secret, otpauthUri } = await service.startEnrollment('u1');

      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(otpauthUri).toContain(`secret=${secret}`);
      expect(otpauthUri).toContain('otpauth://totp/Ama%20Shop:staff%40example.com');
      const [, sealed] = repository.savePendingSecret.mock.calls[0];
      expect(sealed).not.toContain(secret);
      expect(openSecret(KEY, sealed, 'u1')).toBe(secret);
    });

    it('refuses when MFA is already enabled', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());

      await expect(service.startEnrollment('u1')).rejects.toThrow(ConflictException);
      expect(repository.savePendingSecret).not.toHaveBeenCalled();
    });
  });

  describe('confirmEnrollment', () => {
    beforeEach(() => repository.findMfaState.mockResolvedValue(enabledState({ mfaEnabledAt: null })));

    it('turns MFA on with 10 hashed recovery codes, audits it and marks the session verified', async () => {
      const codes = await service.confirmEnrollment('u1', 'session-1', currentCode());

      expect(codes).toHaveLength(10);
      expect(repository.claimTimeStep).toHaveBeenCalledWith('u1', timeStep(Date.now()), AUDIT_TX);
      const [, , hashes] = repository.enable.mock.calls[0];
      expect(hashes).toEqual(codes.map((code) => hashRecoveryCode(KEY, 'u1', code)));
      expect(audit.log).toHaveBeenCalledWith(
        { entity: 'User', entityId: 'u1', action: 'MFA_ENABLE', userId: 'u1', details: { recoveryCodes: 10 } },
        AUDIT_TX,
      );
      expect(stepUpStore.markVerified).toHaveBeenCalledWith('u1', 'session-1', expect.any(Number));
    });

    it('rejects a wrong code without enabling anything', async () => {
      await expect(service.confirmEnrollment('u1', 'session-1', '000000')).rejects.toThrow(BadRequestException);
      expect(repository.enable).not.toHaveBeenCalled();
      expect(stepUpStore.markVerified).not.toHaveBeenCalled();
    });

    it('rejects a code whose step another request already used', async () => {
      repository.claimTimeStep.mockResolvedValue(false);

      await expect(service.confirmEnrollment('u1', 'session-1', currentCode())).rejects.toThrow(
        'Invalid two-factor code',
      );
    });

    it('needs a started enrolment', async () => {
      repository.findMfaState.mockResolvedValue(enabledState({ mfaEnabledAt: null, mfaSecret: null }));

      await expect(service.confirmEnrollment('u1', 's', currentCode())).rejects.toThrow(
        'Start enrolment with startMfaEnrollment first',
      );
    });
  });

  describe('verifySecondFactor', () => {
    it('accepts a current TOTP code and records its step', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());

      await expect(service.verifySecondFactor('u1', currentCode())).resolves.toBe('totp');
      expect(repository.claimTimeStep).toHaveBeenCalledWith('u1', timeStep(Date.now()));
    });

    it('rejects a replay of the last used step without asking the database', async () => {
      repository.findMfaState.mockResolvedValue(enabledState({ mfaLastUsedStep: timeStep(Date.now()) }));

      await expect(service.verifySecondFactor('u1', currentCode())).resolves.toBeNull();
      expect(repository.claimTimeStep).not.toHaveBeenCalled();
    });

    it('rejects a code that loses the race to claim its step', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());
      repository.claimTimeStep.mockResolvedValue(false);

      await expect(service.verifySecondFactor('u1', currentCode())).resolves.toBeNull();
    });

    it('accepts an unused recovery code once and audits its use', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());

      await expect(service.verifySecondFactor('u1', 'ABCDE-FGHIJ')).resolves.toBe('recovery');
      expect(repository.consumeRecoveryCode).toHaveBeenCalledWith('u1', hashRecoveryCode(KEY, 'u1', 'abcdefghij'));
      expect(audit.log).toHaveBeenCalledWith({
        entity: 'User',
        entityId: 'u1',
        action: 'MFA_RECOVERY_CODE_USED',
        userId: 'u1',
      });

      repository.consumeRecoveryCode.mockResolvedValue(false);
      await expect(service.verifySecondFactor('u1', 'abcde-fghij')).resolves.toBeNull();
    });

    it('returns null when MFA is not enabled', async () => {
      repository.findMfaState.mockResolvedValue(enabledState({ mfaEnabledAt: null }));

      await expect(service.verifySecondFactor('u1', currentCode())).resolves.toBeNull();
    });
  });

  describe('stepUp', () => {
    it('marks the session verified for 10 minutes and audits the method', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());
      const before = Date.now();

      const validUntil = await service.stepUp('u1', 'session-1', currentCode());

      expect(validUntil.getTime()).toBeGreaterThanOrEqual(before + STEP_UP_WINDOW_MS);
      expect(stepUpStore.markVerified).toHaveBeenCalledWith('u1', 'session-1', expect.any(Number));
      expect(audit.log).toHaveBeenCalledWith({
        entity: 'User',
        entityId: 'u1',
        action: 'STEP_UP',
        userId: 'u1',
        details: { method: 'totp' },
      });
    });

    it('rejects a wrong code, a user without MFA and a token without a session', async () => {
      repository.findMfaState.mockResolvedValue(enabledState());
      await expect(service.stepUp('u1', 's', '000000')).rejects.toThrow('Invalid two-factor code');

      repository.findMfaState.mockResolvedValue(enabledState({ mfaEnabledAt: null }));
      await expect(service.stepUp('u1', 's', currentCode())).rejects.toThrow('Enrol two-factor authentication first');

      await expect(service.stepUp('u1', undefined, currentCode())).rejects.toThrow(UnauthorizedException);
      expect(stepUpStore.markVerified).not.toHaveBeenCalled();
    });
  });
});
