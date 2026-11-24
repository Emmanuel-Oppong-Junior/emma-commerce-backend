import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '../generated/prisma/client';
import { createHash, randomBytes } from 'crypto';
import { UsersRepository } from './users.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { LoggerService } from '../commons/logger.service';

const VERIFICATION_TOKEN_TTL_HOURS = 24;
const VERIFICATION_TOKEN_TTL_MS = VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly notificationsService: NotificationsService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Emails a new account a token that verifies its address. Runs after the caller returns: a failure is logged
   * and the user can ask for another email with `resendVerificationEmail`.
   */
  sendSignUpVerification(user: User): void {
    this.issueToken(user.id, user.email).catch((error: unknown) => {
      const trace = error instanceof Error ? error.stack : String(error);
      this.logger.error(`Sign-up verification email failed for user ${user.id}`, trace, EmailVerificationService.name);
    });
  }

  /**
   * Sends a fresh verification token to the address awaiting verification: the pending new email if a change is
   * in progress, otherwise the account's current email. Replaces any earlier token.
   * @throws BadRequestException if there is nothing to verify or the last email went out under a minute ago.
   */
  async resend(userId: string): Promise<boolean> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    const target = user.pendingEmail ?? (user.emailVerifiedAt ? null : user.email);
    if (!target) throw new BadRequestException('Your email address is already verified');

    const lastSentAt = user.emailVerificationTokenExp
      ? user.emailVerificationTokenExp.getTime() - VERIFICATION_TOKEN_TTL_MS
      : null;
    if (lastSentAt !== null && Date.now() - lastSentAt < RESEND_COOLDOWN_MS) {
      throw new BadRequestException(
        'A verification email was sent less than a minute ago; please wait before retrying',
      );
    }

    await this.issueToken(user.id, target);
    return true;
  }

  /**
   * Starts an email change: stores the new address as pending (with any other profile changes), emails it a
   * verification token and tells the current address. The account keeps its current email until the token is used.
   * @throws ConflictException if another account already uses the new address.
   */
  async requestEmailChange(
    user: User,
    newEmail: string,
    otherChanges: Prisma.UserUpdateInput = {},
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    const owner = await this.usersRepository.findByEmail(newEmail);
    if (owner && owner.id !== user.id) throw new ConflictException('This email address is already in use');

    const updated = await this.issueToken(user.id, newEmail, { ...otherChanges, pendingEmail: newEmail }, tx);
    this.notificationsService.sendEmailChangeRequested(user.id, user.email, newEmail);
    return updated;
  }

  /**
   * Consumes a verification token. Verifies the current email, or completes a pending email change (which signs
   * the user out everywhere). The first verification of a new account is followed by the welcome email.
   * @throws BadRequestException if the token is unknown, expired or already used.
   * @throws ConflictException if the pending address was taken by another account; the change is cancelled.
   */
  async verify(token: string): Promise<boolean> {
    const outcome = await this.usersRepository.consumeEmailVerificationToken(this.hashToken(token));
    switch (outcome.status) {
      case 'invalid':
        throw new BadRequestException('Invalid or expired verification token');
      case 'email-taken':
        throw new ConflictException('This email address is already in use; the email change was cancelled');
      case 'verified':
        if (outcome.firstVerification) {
          this.notificationsService.sendWelcomeEmail(outcome.user.id, outcome.user.email, outcome.user.name ?? '');
        }
        return true;
      case 'email-changed':
        return true;
    }
  }

  private async issueToken(
    userId: string,
    sendTo: string,
    data?: Prisma.UserUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    const user = await this.usersRepository.saveEmailVerificationToken(
      userId,
      { hash: this.hashToken(token), expiresAt },
      data,
      tx,
    );
    this.notificationsService.sendEmailVerification(userId, sendTo, token, VERIFICATION_TOKEN_TTL_HOURS);
    return user;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
