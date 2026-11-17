import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { Role } from '../../users/enums/role.enum';
import { HashingService } from '../hashing/hashing.service';
import { User } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import jwtConfig from '../config/jwt.config';
import { ConfigType } from '@nestjs/config';
import { SignUpInput } from './dto/sign-up.input';
import { SignInInput } from './dto/sign-in.input';
import { RefreshTokenInput } from './dto/refresh-token.input';
import { UsersRepository } from '../../users/users.repository';
import { createHash, randomUUID } from 'crypto';
import { NotificationsService } from '../../notifications/notifications.service';
import { LoggerService } from '../../commons/logger.service';

@Injectable()
export class AuthenticationService {
  constructor(
    private readonly userService: UsersService,
    private readonly passwordService: HashingService,
    private readonly jwtServices: JwtService,
    private readonly usersRepository: UsersRepository,
    private readonly notificationsService: NotificationsService,
    private readonly logger: LoggerService,
    @Inject(jwtConfig.KEY)
    private readonly jwtConfiguration: ConfigType<typeof jwtConfig>,
  ) {}

  /**
   * Registers a new user by creating an account with the provided sign-up details.
   *
   * @throws ConflictException - If a user with the provided email already exists.
   * @returns Access and refresh tokens for the newly created user.
   */
  async signUp(signUpInput: SignUpInput) {
    const { email, password, name } = signUpInput;
    const findUser = await this.userService.findUserByEmail(email);
    if (findUser) throw new ConflictException('User already exist!');
    const user = await this.userService.createUserByCredentials({
      email,
      password,
      name,
      role: Role.USER,
      isActive: true,
    });
    this.notificationsService.sendWelcomeEmail(email, name ?? '');
    return this.generateTokens(user);
  }

  /**
   * Authenticates a user with email and password.
   * Enforces account lockout after 5 consecutive failed attempts (15-minute cooldown).
   *
   * @throws UnauthorizedException - If credentials are invalid or the account is locked.
   */
  async signIn(signInDto: SignInInput) {
    const user = await this.userService.findUserByEmail(signInDto.email);
    if (!user || !user.password) throw new UnauthorizedException('Invalid email or password');

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException(
        `Account is temporarily locked due to too many failed attempts. Try again in ${remainingSeconds} seconds.`,
      );
    }

    const isPasswordEqual = await this.passwordService.compare(signInDto.password, user.password);
    if (!isPasswordEqual) {
      await this.userService.recordFailedLoginAttempt(user);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.failedLoginAttempts > 0) {
      await this.userService.resetFailedLoginAttempts(user.id);
    }

    return await this.generateTokens(user);
  }

  /**
   * Issues new tokens using a valid refresh token (rotation).
   * The supplied refresh token is revoked and replaced; presenting it again revokes all of the user's sessions.
   * A session cannot be refreshed past `sessionMaxTtl` from its original sign-in.
   *
   * @throws UnauthorizedException - If the token is invalid, already used, the session is too old, or the user is inactive.
   */
  async refreshToken(refreshTokenInput: RefreshTokenInput) {
    const { sub: userId, sessionStart } = await this.verifyRefreshToken(refreshTokenInput.refreshToken);
    const sessionSecondsLeft = sessionStart + this.jwtConfiguration.sessionMaxTtl - Math.floor(Date.now() / 1000);
    if (sessionSecondsLeft <= 0) throw new UnauthorizedException('Session has expired, please sign in again');

    const user = await this.userService.findOne(userId);
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.isActive) throw new UnauthorizedException('Account is inactive');

    const refreshTtl = Math.min(this.jwtConfiguration.refreshTokenTtl, sessionSecondsLeft);
    const [accessToken, newRefreshToken] = await Promise.all([
      this.signToken(user.id, this.jwtConfiguration.accessTokenTtl, this.jwtConfiguration.secret!),
      this.signToken(user.id, refreshTtl, this.jwtConfiguration.refreshSecret!, { sessionStart }),
    ]);

    const outcome = await this.usersRepository.rotateRefreshToken(
      this.hashToken(refreshTokenInput.refreshToken),
      user.id,
      this.hashToken(newRefreshToken),
      new Date(Date.now() + refreshTtl * 1000),
    );
    if (outcome === 'reused') {
      this.logger.warn(
        `Refresh token reuse detected; revoked all sessions of user ${user.id}`,
        AuthenticationService.name,
      );
    }
    if (outcome !== 'rotated') throw new UnauthorizedException('Invalid or expired refresh token');

    await this.userService.updateLastLogin(user.id);
    return { accessToken, refreshToken: newRefreshToken };
  }

  private async verifyRefreshToken(token: string): Promise<{ sub: string; sessionStart: number }> {
    try {
      const payload = await this.jwtServices.verifyAsync<{ sub: string; iat: number; sessionStart?: number }>(token, {
        audience: this.jwtConfiguration.audience,
        issuer: this.jwtConfiguration.issuer,
        secret: this.jwtConfiguration.refreshSecret,
      });
      // Tokens issued before sessionStart existed fall back to their own issue time.
      return { sub: payload.sub, sessionStart: payload.sessionStart ?? payload.iat };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Revokes a refresh token, effectively signing the user out.
   * Silent success if the token is not found — idempotent by design.
   *
   * @param refreshToken - The raw refresh token string to revoke.
   */
  async signOut(refreshToken: string): Promise<boolean> {
    const tokenHash = this.hashToken(refreshToken);
    await this.usersRepository.revokeRefreshTokensByHash(tokenHash);
    return true;
  }

  /**
   * Initiates a password reset and returns `true` at once whether or not the email has an account.
   * The lookup, token and email run after the response, so neither its content nor its timing reveals which.
   */
  forgotPassword(email: string): Promise<boolean> {
    this.issuePasswordReset(email).catch((error: unknown) => {
      const trace = error instanceof Error ? error.stack : String(error);
      this.logger.error('Password reset request failed', trace, AuthenticationService.name);
    });
    return Promise.resolve(true);
  }

  private async issuePasswordReset(email: string): Promise<void> {
    const user = await this.userService.findUserByEmail(email);
    if (!user) return;

    const resetToken = await this.signToken(
      user.id,
      this.jwtConfiguration.resetTokenTtl,
      this.jwtConfiguration.resetSecret!,
      { purpose: 'password-reset' },
    );
    const tokenHash = this.hashToken(resetToken);
    const expiresAt = new Date(Date.now() + this.jwtConfiguration.resetTokenTtl * 1000);

    await this.usersRepository.savePasswordResetToken(user.id, tokenHash, expiresAt);
    this.notificationsService.sendPasswordReset(email, resetToken);
  }

  /**
   * Resets the user's password using a valid reset token.
   * @throws UnauthorizedException if the token is invalid or expired.
   */
  async resetPassword(resetToken: string, newPassword: string): Promise<boolean> {
    try {
      await this.jwtServices.verifyAsync<{ sub: string; purpose: string }>(resetToken, {
        audience: this.jwtConfiguration.audience,
        issuer: this.jwtConfiguration.issuer,
        secret: this.jwtConfiguration.resetSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const tokenHash = this.hashToken(resetToken);
    const user = await this.usersRepository.findByResetToken(tokenHash);
    if (!user) throw new UnauthorizedException('Invalid or expired reset token');

    const hashedPassword = await this.passwordService.hash(newPassword);
    await this.usersRepository.updateAndRevokeSessions(user.id, { password: hashedPassword });
    await this.usersRepository.clearPasswordResetToken(user.id);
    return true;
  }

  /**
   * Starts a new session: generates an access + refresh token pair for a user.
   * Persists the refresh token hash and purges expired tokens for that user.
   */
  async generateTokens(user: User) {
    const sessionStart = Math.floor(Date.now() / 1000);
    const [accessToken, refreshToken] = await Promise.all([
      this.signToken(user.id, this.jwtConfiguration.accessTokenTtl, this.jwtConfiguration.secret!),
      this.signToken(user.id, this.jwtConfiguration.refreshTokenTtl, this.jwtConfiguration.refreshSecret!, {
        sessionStart,
      }),
    ]);
    await Promise.all([this.saveRefreshToken(user.id, refreshToken), this.userService.updateLastLogin(user.id)]);
    return { accessToken, refreshToken };
  }

  private async saveRefreshToken(userId: string, token: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.jwtConfiguration.refreshTokenTtl * 1000);
    await this.usersRepository.deleteExpiredRefreshTokens(userId);
    await this.usersRepository.createRefreshToken(userId, tokenHash, expiresAt);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async signToken<T>(userId: string, expiresIn: number, secret: string, payload?: T) {
    return await this.jwtServices.signAsync(
      { sub: userId, ...payload },
      {
        audience: this.jwtConfiguration.audience,
        issuer: this.jwtConfiguration.issuer,
        secret,
        expiresIn,
        // Without it, two tokens for one user in the same second are identical and collide on tokenHash.
        jwtid: randomUUID(),
      },
    );
  }
}
