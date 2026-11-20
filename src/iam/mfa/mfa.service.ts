import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../commons/audit.service';
import { MfaRepository } from './mfa.repository';
import { StepUpStore, STEP_UP_WINDOW_MS } from './step-up.store';
import { base32Decode, base32Encode, matchTotp, otpauthUri } from './totp';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  openSecret,
  parseMfaKey,
  RECOVERY_CODE_COUNT,
  sealSecret,
} from './mfa-crypto';

export type SecondFactorMethod = 'totp' | 'recovery';

const TOTP_SECRET_BYTES = 20;
const INVALID_CODE = 'Invalid two-factor code';

type MfaState = NonNullable<Awaited<ReturnType<MfaRepository['findMfaState']>>>;

@Injectable()
export class MfaService {
  private readonly key: Buffer;

  constructor(
    private readonly mfaRepository: MfaRepository,
    private readonly stepUpStore: StepUpStore,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.key = parseMfaKey(configService.getOrThrow<string>('MFA_ENCRYPTION_KEY'));
  }

  /** Creates a new secret (replacing an unconfirmed one) and returns it with the otpauth URI to scan. */
  async startEnrollment(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const state = await this.findStateOrThrow(userId);
    if (state.mfaEnabledAt) throw new ConflictException('Two-factor authentication is already enabled');
    const secret = base32Encode(randomBytes(TOTP_SECRET_BYTES));
    if (!(await this.mfaRepository.savePendingSecret(userId, sealSecret(this.key, secret, userId)))) {
      throw new ConflictException('Two-factor authentication is already enabled');
    }
    return { secret, otpauthUri: otpauthUri(await this.mfaRepository.findIssuerName(), state.email, secret) };
  }

  /**
   * Confirms enrolment with a first code, turns MFA on and returns the recovery codes, which are shown only now.
   * The confirming session counts as freshly verified for step-up. Audited.
   */
  async confirmEnrollment(userId: string, sessionId: string | undefined, code: string): Promise<string[]> {
    const state = await this.findStateOrThrow(userId);
    if (state.mfaEnabledAt) throw new ConflictException('Two-factor authentication is already enabled');
    if (!state.mfaSecret) throw new BadRequestException('Start enrolment with startMfaEnrollment first');
    const now = Date.now();
    const step = matchTotp(this.secretOf(state), code.trim(), now, state.mfaLastUsedStep);
    if (step === null) throw new BadRequestException(INVALID_CODE);

    const codes = generateRecoveryCodes();
    const hashes = codes.map((recoveryCode) => hashRecoveryCode(this.key, userId, recoveryCode));
    await this.auditService.record(
      async (tx) => {
        if (!(await this.mfaRepository.claimTimeStep(userId, step, tx))) throw new BadRequestException(INVALID_CODE);
        if (!(await this.mfaRepository.enable(tx, userId, hashes, new Date(now)))) {
          throw new ConflictException('Two-factor authentication is already enabled');
        }
      },
      () => ({
        entity: 'User',
        entityId: userId,
        action: 'MFA_ENABLE',
        userId,
        details: { recoveryCodes: RECOVERY_CODE_COUNT },
      }),
    );
    if (sessionId) await this.stepUpStore.markVerified(userId, sessionId, now);
    return codes;
  }

  /**
   * Checks a second factor: a current TOTP code (6 digits) or an unused recovery code. A match is used up, so the
   * same TOTP step or recovery code is never accepted twice. Returns null if MFA is off or the code does not match.
   */
  async verifySecondFactor(userId: string, code: string): Promise<SecondFactorMethod | null> {
    const state = await this.mfaRepository.findMfaState(userId);
    if (!state?.mfaEnabledAt || !state.mfaSecret) return null;
    const candidate = code.trim();
    if (/^\d{6}$/.test(candidate)) {
      const step = matchTotp(this.secretOf(state), candidate, Date.now(), state.mfaLastUsedStep);
      return step !== null && (await this.mfaRepository.claimTimeStep(userId, step)) ? 'totp' : null;
    }
    const used = await this.mfaRepository.consumeRecoveryCode(userId, hashRecoveryCode(this.key, userId, candidate));
    if (!used) return null;
    await this.auditService.log({
      entity: 'User',
      entityId: userId,
      action: 'MFA_RECOVERY_CODE_USED',
      userId,
    });
    return 'recovery';
  }

  /** Re-verifies the signed-in session with a second factor; sensitive actions are allowed for 10 minutes. Audited. */
  async stepUp(userId: string, sessionId: string | undefined, code: string): Promise<Date> {
    if (!sessionId) throw new UnauthorizedException('This session predates step-up support: sign in again');
    const state = await this.findStateOrThrow(userId);
    if (!state.mfaEnabledAt) throw new BadRequestException('Enrol two-factor authentication first');
    const method = await this.verifySecondFactor(userId, code);
    if (!method) throw new BadRequestException(INVALID_CODE);
    const now = Date.now();
    await this.auditService.log({ entity: 'User', entityId: userId, action: 'STEP_UP', userId, details: { method } });
    await this.stepUpStore.markVerified(userId, sessionId, now);
    return new Date(now + STEP_UP_WINDOW_MS);
  }

  private secretOf(state: MfaState): Buffer {
    return base32Decode(openSecret(this.key, state.mfaSecret!, state.id));
  }

  private async findStateOrThrow(userId: string): Promise<MfaState> {
    const state = await this.mfaRepository.findMfaState(userId);
    if (!state) throw new NotFoundException('User not found');
    return state;
  }
}
