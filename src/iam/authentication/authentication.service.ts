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

@Injectable()
export class AuthenticationService {
  constructor(
    private readonly userService: UsersService,
    private readonly passwordService: HashingService,
    private readonly jwtServices: JwtService,
    private readonly usersRepository: UsersRepository,
    private readonly notificationsService: NotificationsService,
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
   * The supplied refresh token is revoked immediately and replaced with a new one.
   * Re-validates that the user's account is still active.
   * [HIGH-2] Revoke + create are now atomic via a Prisma $transaction.
   *
   * @throws UnauthorizedException - If the token is invalid, revoked, or the user is inactive.
   */
  async refreshToken(refreshTokenInput: RefreshTokenInput) {
    try {
      const { sub: userId } = await this.jwtServices.verifyAsync<{ sub: string }>(refreshTokenInput.refreshToken, {
        audience: this.jwtConfiguration.audience,
        issuer: this.jwtConfiguration.issuer,
        secret: this.jwtConfiguration.refreshSecret,
      });

      const tokenHash = this.hashToken(refreshTokenInput.refreshToken);
      const storedToken = await this.usersRepository.findRefreshToken(tokenHash);
      if (!storedToken || storedToken.revoked) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const user = await this.userService.findOne(userId);
      if (!user) throw new UnauthorizedException('User not found');
      if (!user.isActive) throw new UnauthorizedException('Account is inactive');

      // Sign new tokens before touching the DB (pure CPU, no side-effects)
      const [accessToken, newRefreshToken] = await Promise.all([
        this.signToken(user.id, this.jwtConfiguration.accessTokenTtl, this.jwtConfiguration.secret!),
        this.signToken(user.id, this.jwtConfiguration.refreshTokenTtl, this.jwtConfiguration.refreshSecret!),
      ]);
      const newTokenHash = this.hashToken(newRefreshToken);
      const expiresAt = new Date(Date.now() + this.jwtConfiguration.refreshTokenTtl * 1000);

      // Atomic: revoke old token + persist new one in one transaction
      await this.usersRepository.rotateRefreshToken(tokenHash, user.id, newTokenHash, expiresAt);
      await this.userService.updateLastLogin(user.id);

      return { accessToken, refreshToken: newRefreshToken };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
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
   * Initiates a password reset by generating a signed reset token and emailing it.
   * Silent success even if email not found (prevents user enumeration).
   */
  async forgotPassword(email: string): Promise<boolean> {
    const user = await this.userService.findUserByEmail(email);
    if (!user) return true;

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
    return true;
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
    await this.usersRepository.update(user.id, { password: hashedPassword });
    await this.usersRepository.clearPasswordResetToken(user.id);
    return true;
  }

  /**
   * Generates a new access + refresh token pair for a user.
   * Persists the refresh token hash and purges expired tokens for that user.
   */
  async generateTokens(user: User) {
    const [accessToken, refreshToken] = await Promise.all([
      this.signToken(user.id, this.jwtConfiguration.accessTokenTtl, this.jwtConfiguration.secret!),
      this.signToken(user.id, this.jwtConfiguration.refreshTokenTtl, this.jwtConfiguration.refreshSecret!),
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
