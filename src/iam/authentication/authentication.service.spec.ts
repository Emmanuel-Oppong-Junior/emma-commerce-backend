import { Test, TestingModule } from '@nestjs/testing';
import { AuthenticationService } from './authentication.service';
import { UsersService } from '../../users/users.service';
import { UsersRepository } from '../../users/users.repository';
import { HashingService } from '../hashing/hashing.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import jwtConfig from '../config/jwt.config';
import { Role } from '../../users/enums/role.enum';
import { SignUpInput } from './dto/sign-up.input';
import { SignInInput } from './dto/sign-in.input';
import { User } from '../../generated/prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { NotificationsService } from '../../notifications/notifications.service';
import { LoggerService } from '../../commons/logger.service';
import { EmailVerificationService } from '../../users/email-verification.service';
import { MfaService } from '../mfa/mfa.service';
import { StepUpStore } from '../mfa/step-up.store';

const mockUsersService = {
  findUserByEmail: jest.fn(),
  createUserByCredentials: jest.fn(),
  updateLastLogin: jest.fn(),
  findOne: jest.fn(),
  recordFailedLoginAttempt: jest.fn(),
  resetFailedLoginAttempts: jest.fn(),
};

const mockUsersRepository = {
  findRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
  revokeRefreshTokensByHash: jest.fn(),
  deleteExpiredRefreshTokens: jest.fn(),
  createRefreshToken: jest.fn(),
  rotateRefreshToken: jest.fn(),
  savePasswordResetToken: jest.fn(),
  findByResetToken: jest.fn(),
  clearPasswordResetToken: jest.fn(),
  update: jest.fn(),
  updateAndRevokeSessions: jest.fn(),
};

const mockHashingService = {
  hash: jest.fn(),
  compare: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn(),
  verifyAsync: jest.fn(),
};

const mockJwtConfig = {
  secret: 'test-secret',
  refreshSecret: 'test-refresh-secret',
  resetSecret: 'test-reset-secret',
  audience: 'test-audience',
  issuer: 'test-issuer',
  accessTokenTtl: 3600,
  refreshTokenTtl: 86400,
  resetTokenTtl: 900,
  sessionMaxTtl: 30 * 86400,
};

const mockNotificationsService = {
  sendWelcomeEmail: jest.fn(),
  sendPasswordReset: jest.fn(),
};

const mockEmailVerificationService = {
  sendSignUpVerification: jest.fn(),
};

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
};

const mockMfaService = {
  verifySecondFactor: jest.fn(),
};

const mockStepUpStore = {
  markVerified: jest.fn(),
};

const flushBackgroundWork = () => new Promise((resolve) => setImmediate(resolve));

const baseUser: Partial<User> = {
  id: '1',
  email: 'test@example.com',
  role: Role.USER,
  isActive: true,
  password: 'hashedPass',
  failedLoginAttempts: 0,
  lockedUntil: null,
};

describe('AuthenticationService', () => {
  let service: AuthenticationService;
  let usersService: jest.Mocked<typeof mockUsersService>;
  let hashingService: jest.Mocked<typeof mockHashingService>;
  let jwtService: jest.Mocked<typeof mockJwtService>;
  let usersRepository: jest.Mocked<typeof mockUsersRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(jwtConfig)],
      providers: [
        AuthenticationService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: UsersRepository, useValue: mockUsersRepository },
        { provide: HashingService, useValue: mockHashingService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: jwtConfig.KEY, useValue: mockJwtConfig },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: EmailVerificationService, useValue: mockEmailVerificationService },
        { provide: MfaService, useValue: mockMfaService },
        { provide: StepUpStore, useValue: mockStepUpStore },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
    usersService = module.get(UsersService);
    hashingService = module.get(HashingService);
    jwtService = module.get(JwtService);
    usersRepository = module.get(UsersRepository);

    jest.clearAllMocks();
  });

  describe('signUp', () => {
    it('should sign up a new user and return tokens', async () => {
      const input: SignUpInput = { email: 'test@example.com', password: 'password123', name: 'Test' };

      mockUsersService.findUserByEmail.mockResolvedValue(null);
      mockUsersService.createUserByCredentials.mockResolvedValue(baseUser);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockUsersRepository.deleteExpiredRefreshTokens.mockResolvedValue(undefined);
      mockUsersRepository.createRefreshToken.mockResolvedValue(undefined);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.signUp(input);

      expect(usersService.findUserByEmail).toHaveBeenCalledWith(input.email);
      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
      expect(usersRepository.createRefreshToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });

    it('emails a verification token instead of the welcome email', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(null);
      mockUsersService.createUserByCredentials.mockResolvedValue(baseUser);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');

      await service.signUp({ email: 'test@example.com', password: 'Password@1', name: 'Test' });

      expect(mockEmailVerificationService.sendSignUpVerification).toHaveBeenCalledWith(baseUser);
      expect(mockNotificationsService.sendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if user already exists', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue({ id: '1' });

      await expect(service.signUp({ email: 'test@example.com', password: 'p', name: 'T' })).rejects.toThrow(
        'User already exist!',
      );
    });
  });

  describe('signIn', () => {
    it('should sign in successfully and return tokens', async () => {
      const input: SignInInput = { email: 'test@example.com', password: 'password123' };

      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockUsersRepository.deleteExpiredRefreshTokens.mockResolvedValue(undefined);
      mockUsersRepository.createRefreshToken.mockResolvedValue(undefined);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.signIn(input);

      expect(hashingService.compare).toHaveBeenCalledWith(input.password, baseUser.password);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });

    it('should throw if user not found', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(null);

      await expect(service.signIn({ email: 'x@x.com', password: 'p' })).rejects.toThrow('Invalid email or password');
    });

    it('should increment failed attempts and throw on wrong password', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockHashingService.compare.mockResolvedValue(false);
      mockUsersService.recordFailedLoginAttempt.mockResolvedValue(undefined);

      await expect(service.signIn({ email: baseUser.email!, password: 'wrong' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(usersService.recordFailedLoginAttempt).toHaveBeenCalledWith(baseUser);
    });

    it('should throw if account is locked', async () => {
      const lockedUser = { ...baseUser, lockedUntil: new Date(Date.now() + 60_000) };
      mockUsersService.findUserByEmail.mockResolvedValue(lockedUser);

      await expect(service.signIn({ email: baseUser.email!, password: 'any' })).rejects.toThrow(UnauthorizedException);
    });

    it('should reset failed attempts after successful sign-in with prior failures', async () => {
      const userWithAttempts = { ...baseUser, failedLoginAttempts: 3 };
      mockUsersService.findUserByEmail.mockResolvedValue(userWithAttempts);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockUsersRepository.deleteExpiredRefreshTokens.mockResolvedValue(undefined);
      mockUsersRepository.createRefreshToken.mockResolvedValue(undefined);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);
      mockUsersService.resetFailedLoginAttempts.mockResolvedValue(undefined);

      await service.signIn({ email: baseUser.email!, password: 'correct' });

      expect(usersService.resetFailedLoginAttempts).toHaveBeenCalledWith(userWithAttempts.id);
    });

    it('gives every token a unique jwtid so same-second tokens never collide', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValue('token');
      mockUsersRepository.deleteExpiredRefreshTokens.mockResolvedValue(undefined);
      mockUsersRepository.createRefreshToken.mockResolvedValue(undefined);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      await service.signIn({ email: baseUser.email!, password: 'correct' });
      await service.signIn({ email: baseUser.email!, password: 'correct' });

      const jwtIds = jwtService.signAsync.mock.calls.map(([, options]) => (options as { jwtid?: string }).jwtid);
      expect(jwtIds).toHaveLength(4);
      jwtIds.forEach((id) => expect(id).toEqual(expect.any(String)));
      expect(new Set(jwtIds).size).toBe(4);
    });
  });

  describe('refreshToken', () => {
    const rawToken = 'valid-refresh-token';
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    const arrangeValidRefresh = (payload: Record<string, unknown>, outcome: string) => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', iat: nowSeconds(), ...payload });
      mockUsersService.findOne.mockResolvedValue(baseUser);
      mockJwtService.signAsync.mockResolvedValueOnce('new-access').mockResolvedValueOnce('new-refresh');
      mockUsersRepository.rotateRefreshToken.mockResolvedValue(outcome);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);
    };

    it('rotates the presented token and returns a new token pair', async () => {
      arrangeValidRefresh({ sessionStart: nowSeconds() }, 'rotated');

      const result = await service.refreshToken({ refreshToken: rawToken });

      expect(usersRepository.rotateRefreshToken).toHaveBeenCalledWith(
        tokenHash,
        baseUser.id,
        createHash('sha256').update('new-refresh').digest('hex'),
        expect.any(Date),
      );
      expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    });

    it('carries the original session start into the new refresh token', async () => {
      const sessionStart = nowSeconds() - 3 * 86400;
      arrangeValidRefresh({ sessionStart }, 'rotated');

      await service.refreshToken({ refreshToken: rawToken });

      const [refreshPayload] = jwtService.signAsync.mock.calls[1];
      expect(refreshPayload).toEqual(expect.objectContaining({ sub: '1', sessionStart }));
    });

    it('uses the issue time as the session start for tokens issued without one', async () => {
      const iat = nowSeconds() - 600;
      arrangeValidRefresh({ iat }, 'rotated');

      await service.refreshToken({ refreshToken: rawToken });

      const [refreshPayload] = jwtService.signAsync.mock.calls[1];
      expect(refreshPayload).toEqual(expect.objectContaining({ sessionStart: iat }));
    });

    it('rejects a session older than the absolute lifetime without rotating', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: '1',
        sessionStart: nowSeconds() - mockJwtConfig.sessionMaxTtl - 1,
      });

      await expect(service.refreshToken({ refreshToken: rawToken })).rejects.toThrow('Session has expired');
      expect(usersRepository.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('caps the new refresh token at the time left in the session', async () => {
      const secondsLeft = 600;
      arrangeValidRefresh({ sessionStart: nowSeconds() - mockJwtConfig.sessionMaxTtl + secondsLeft }, 'rotated');

      await service.refreshToken({ refreshToken: rawToken });

      const [, refreshOptions] = jwtService.signAsync.mock.calls[1];
      const refreshTtl = (refreshOptions as { expiresIn: number }).expiresIn;
      expect(refreshTtl).toBeLessThanOrEqual(secondsLeft);
      expect(refreshTtl).toBeGreaterThan(secondsLeft - 5);
      const [, , , expiresAt] = usersRepository.rotateRefreshToken.mock.calls[0];
      expect((expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + secondsLeft * 1000);
    });

    it('rejects a reused token and logs the reuse', async () => {
      arrangeValidRefresh({ sessionStart: nowSeconds() }, 'reused');

      await expect(service.refreshToken({ refreshToken: rawToken })).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('reuse'), AuthenticationService.name);
      expect(usersService.updateLastLogin).not.toHaveBeenCalled();
    });

    it('rejects a token that is unknown or expired in the database', async () => {
      arrangeValidRefresh({ sessionStart: nowSeconds() }, 'invalid');

      await expect(service.refreshToken({ refreshToken: rawToken })).rejects.toThrow(
        'Invalid or expired refresh token',
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should throw if user is inactive', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', iat: nowSeconds() });
      mockUsersService.findOne.mockResolvedValue({ ...baseUser, isActive: false });

      await expect(service.refreshToken({ refreshToken: 'token' })).rejects.toThrow('Account is inactive');
    });

    it('should throw if JWT verification fails', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(service.refreshToken({ refreshToken: 'bad-token' })).rejects.toThrow(
        'Invalid or expired refresh token',
      );
    });
  });

  describe('signOut', () => {
    it('should revoke the refresh token and return true', async () => {
      mockUsersRepository.revokeRefreshTokensByHash.mockResolvedValue(undefined);

      const result = await service.signOut('some-refresh-token');

      expect(usersRepository.revokeRefreshTokensByHash).toHaveBeenCalledWith(
        createHash('sha256').update('some-refresh-token').digest('hex'),
      );
      expect(result).toBe(true);
    });

    it('should return true even if the token is not found (idempotent)', async () => {
      mockUsersRepository.revokeRefreshTokensByHash.mockResolvedValue(undefined);

      const result = await service.signOut('unknown-token');

      expect(result).toBe(true);
    });
  });

  describe('forgotPassword', () => {
    it('responds before the account lookup finishes, so response time cannot reveal whether the email exists', async () => {
      mockUsersService.findUserByEmail.mockReturnValue(new Promise(() => undefined));

      await expect(service.forgotPassword(baseUser.email!)).resolves.toBe(true);
      expect(mockNotificationsService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('returns the same result for a known and an unknown email', async () => {
      mockUsersService.findUserByEmail.mockResolvedValueOnce(baseUser).mockResolvedValueOnce(null);
      mockJwtService.signAsync.mockResolvedValueOnce('reset-token');

      const known = await service.forgotPassword(baseUser.email!);
      const unknown = await service.forgotPassword('unknown@example.com');

      expect(known).toEqual(unknown);
    });

    it('stores a hashed reset token and emails the token when the account exists', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockJwtService.signAsync.mockResolvedValueOnce('reset-token');
      mockUsersRepository.savePasswordResetToken.mockResolvedValue(undefined);

      await service.forgotPassword(baseUser.email!);
      await flushBackgroundWork();

      expect(usersRepository.savePasswordResetToken).toHaveBeenCalledWith(
        baseUser.id,
        createHash('sha256').update('reset-token').digest('hex'),
        expect.any(Date),
      );
      expect(mockNotificationsService.sendPasswordReset).toHaveBeenCalledWith(
        baseUser.id,
        baseUser.email,
        'reset-token',
      );
    });

    it('issues nothing when the email has no account', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(null);

      await service.forgotPassword('unknown@example.com');
      await flushBackgroundWork();

      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(usersRepository.savePasswordResetToken).not.toHaveBeenCalled();
      expect(mockNotificationsService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('logs a failure in the background work without the email address', async () => {
      mockUsersService.findUserByEmail.mockRejectedValue(new Error('database unavailable'));

      await expect(service.forgotPassword(baseUser.email!)).resolves.toBe(true);
      await flushBackgroundWork();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Password reset request failed',
        expect.stringContaining('database unavailable'),
        AuthenticationService.name,
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(baseUser.email);
    });
  });

  describe('resetPassword', () => {
    it('should reset password with a valid token', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', purpose: 'password-reset' });
      mockUsersRepository.findByResetToken = jest.fn().mockResolvedValue(baseUser);
      mockHashingService.hash.mockResolvedValue('newHashedPass');
      mockUsersRepository.updateAndRevokeSessions.mockResolvedValue({ ...baseUser, password: 'newHashedPass' });
      mockUsersRepository.clearPasswordResetToken = jest.fn().mockResolvedValue(undefined);

      const result = await service.resetPassword('valid-token', 'NewPass123');

      expect(result).toBe(true);
      expect(mockUsersRepository.updateAndRevokeSessions).toHaveBeenCalledWith(baseUser.id, {
        password: 'newHashedPass',
      });
    });

    it('should throw UnauthorizedException when token verification fails', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(service.resetPassword('bad-token', 'NewPass123')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when reset token not found in DB', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', purpose: 'password-reset' });
      mockUsersRepository.findByResetToken = jest.fn().mockResolvedValue(null);

      await expect(service.resetPassword('stale-token', 'NewPass123')).rejects.toThrow(
        'Invalid or expired reset token',
      );
    });
  });

  describe('generateTokens', () => {
    it('should generate tokens, save hash, and update last login', async () => {
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockUsersRepository.deleteExpiredRefreshTokens.mockResolvedValue(undefined);
      mockUsersRepository.createRefreshToken.mockResolvedValue(undefined);
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.generateTokens(baseUser as User);

      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
      expect(usersRepository.createRefreshToken).toHaveBeenCalledTimes(1);
      expect(usersService.updateLastLogin).toHaveBeenCalledWith(baseUser.id);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });

    it('starts a new session: the refresh token carries the current time as sessionStart', async () => {
      mockJwtService.signAsync.mockResolvedValue('token');
      const before = Math.floor(Date.now() / 1000);

      await service.generateTokens(baseUser as User);

      const [refreshPayload] = jwtService.signAsync.mock.calls[1];
      const { sessionStart } = refreshPayload as { sessionStart: number };
      expect(sessionStart).toBeGreaterThanOrEqual(before);
      expect(sessionStart).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });
  });

  describe('two-factor sign-in', () => {
    const mfaUser = { ...baseUser, mfaEnabledAt: new Date() } as User;
    const reasonOf = (error: unknown) =>
      ((error as UnauthorizedException).getResponse() as { extensions: { reason: string; mfaChallenge: string } })
        .extensions;

    it('demands the second factor instead of issuing tokens, with a short-lived challenge', async () => {
      mockJwtService.signAsync.mockResolvedValue('challenge-token');

      const error = await service.generateTokens(mfaUser).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(reasonOf(error)).toEqual({ reason: 'MFA_REQUIRED', mfaChallenge: 'challenge-token' });
      const [payload, options] = jwtService.signAsync.mock.calls[0];
      expect(payload).toEqual({ sub: '1', purpose: 'mfa-challenge' });
      expect(options).toEqual(expect.objectContaining({ expiresIn: 300 }));
      // Never signed with the access-token secret, so a challenge is not an access token.
      expect((options as { secret: string }).secret).not.toBe(mockJwtConfig.secret);
      expect(usersRepository.createRefreshToken).not.toHaveBeenCalled();
    });

    it('applies to password sign-in', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(mfaUser);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValue('challenge-token');

      await expect(service.signIn({ email: 'test@example.com', password: 'pw' } as SignInInput)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(usersRepository.createRefreshToken).not.toHaveBeenCalled();
    });

    it('completes with a valid code: tokens share a new session id that counts as verified for step-up', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', purpose: 'mfa-challenge' });
      mockUsersService.findOne.mockResolvedValue(mfaUser);
      mockMfaService.verifySecondFactor.mockResolvedValue('totp');
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');

      const result = await service.completeMfaSignIn('challenge', '123456');

      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
      expect(mockMfaService.verifySecondFactor).toHaveBeenCalledWith('1', '123456');
      const [[accessPayload], [refreshPayload]] = jwtService.signAsync.mock.calls as [{ sid: string }][];
      expect(accessPayload.sid).toEqual(expect.any(String));
      expect(refreshPayload.sid).toBe(accessPayload.sid);
      expect(mockStepUpStore.markVerified).toHaveBeenCalledWith('1', accessPayload.sid, expect.any(Number));
    });

    it('rejects a wrong code without issuing tokens', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', purpose: 'mfa-challenge' });
      mockUsersService.findOne.mockResolvedValue(mfaUser);
      mockMfaService.verifySecondFactor.mockResolvedValue(null);

      await expect(service.completeMfaSignIn('challenge', '000000')).rejects.toThrow('Invalid two-factor code');
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('rejects an invalid challenge, another kind of token and an account that is inactive or without MFA', async () => {
      mockJwtService.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
      await expect(service.completeMfaSignIn('expired', '123456')).rejects.toThrow('Invalid or expired challenge');

      mockJwtService.verifyAsync.mockResolvedValueOnce({ sub: '1', purpose: 'password-reset' });
      await expect(service.completeMfaSignIn('reset-token', '123456')).rejects.toThrow('Invalid or expired challenge');

      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1', purpose: 'mfa-challenge' });
      mockUsersService.findOne.mockResolvedValueOnce({ ...mfaUser, isActive: false });
      await expect(service.completeMfaSignIn('c', '123456')).rejects.toThrow(UnauthorizedException);
      mockUsersService.findOne.mockResolvedValueOnce({ ...mfaUser, mfaEnabledAt: null });
      await expect(service.completeMfaSignIn('c', '123456')).rejects.toThrow(UnauthorizedException);
      expect(mockMfaService.verifySecondFactor).not.toHaveBeenCalled();
    });

    it('does not mark a password-only session as verified', async () => {
      mockJwtService.signAsync.mockResolvedValue('token');

      await service.generateTokens(baseUser as User);

      expect(mockStepUpStore.markVerified).not.toHaveBeenCalled();
    });
  });

  describe('session ids', () => {
    it('keeps the session id across refresh', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: '1',
        sessionStart: Math.floor(Date.now() / 1000),
        sid: 'sess-1',
      });
      mockUsersService.findOne.mockResolvedValue(baseUser);
      mockUsersRepository.rotateRefreshToken.mockResolvedValue('rotated');
      mockJwtService.signAsync.mockResolvedValue('token');

      await service.refreshToken({ refreshToken: 'raw' });

      const [[accessPayload], [refreshPayload]] = jwtService.signAsync.mock.calls as [{ sid: string }][];
      expect(accessPayload.sid).toBe('sess-1');
      expect(refreshPayload.sid).toBe('sess-1');
    });
  });
});
