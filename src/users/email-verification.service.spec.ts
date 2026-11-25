import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, User } from '../generated/prisma/client';
import { createHash } from 'crypto';
import { EmailVerificationService } from './email-verification.service';
import { Role } from './enums/role.enum';

const DAY_MS = 24 * 60 * 60 * 1000;
const flushBackgroundWork = () => new Promise((resolve) => setImmediate(resolve));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const user: User = {
  id: 'user-1',
  name: 'Ama Mensah',
  email: 'ama@example.com',
  password: 'hashed',
  role: Role.USER,
  isActive: true,
  profilePicture: null,
  phoneNumber: null,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  passwordResetToken: null,
  passwordResetTokenExp: null,
  emailVerifiedAt: null,
  pendingEmail: null,
  emailVerificationToken: null,
  emailVerificationTokenExp: null,
  mfaSecret: null,
  mfaEnabledAt: null,
  mfaLastUsedStep: null,
  phoneVerifiedAt: null,
  phoneVerifiedNumber: null,
  referralCode: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildService() {
  const repository = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    saveEmailVerificationToken: jest.fn(),
    consumeEmailVerificationToken: jest.fn(),
  };
  const notifications = {
    sendEmailVerification: jest.fn(),
    sendEmailChangeRequested: jest.fn(),
    sendWelcomeEmail: jest.fn(),
  };
  const logger = { error: jest.fn() };
  const service = new EmailVerificationService(repository as never, notifications as never, logger as never);
  return { service, repository, notifications, logger };
}

describe('EmailVerificationService', () => {
  describe('sendSignUpVerification', () => {
    it('stores only the hash of a 24-hour token and emails the raw token to the new address', async () => {
      const { service, repository, notifications } = buildService();
      repository.saveEmailVerificationToken.mockResolvedValue(user);

      service.sendSignUpVerification(user);
      await flushBackgroundWork();

      expect(notifications.sendEmailVerification).toHaveBeenCalledWith(user.id, user.email, expect.any(String), 24);
      const token = notifications.sendEmailVerification.mock.calls[0][2];
      const [userId, saved] = repository.saveEmailVerificationToken.mock.calls[0];
      expect(userId).toBe(user.id);
      expect(saved.hash).toBe(sha256(token));
      expect(saved.hash).not.toBe(token);
      expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now() + DAY_MS - 5000);
    });

    it('logs a failure to store the token instead of rejecting', async () => {
      const { service, repository, notifications, logger } = buildService();
      repository.saveEmailVerificationToken.mockRejectedValue(new Error('db down'));

      service.sendSignUpVerification(user);
      await flushBackgroundWork();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Sign-up verification email failed'),
        expect.stringContaining('db down'),
        EmailVerificationService.name,
      );
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
    });
  });

  describe('resend', () => {
    it('sends a new token to the unverified current email', async () => {
      const { service, repository, notifications } = buildService();
      repository.findById.mockResolvedValue(user);

      await expect(service.resend(user.id)).resolves.toBe(true);

      expect(notifications.sendEmailVerification).toHaveBeenCalledWith(user.id, user.email, expect.any(String), 24);
    });

    it('sends the token to the pending new email while a change is in progress', async () => {
      const { service, repository, notifications } = buildService();
      repository.findById.mockResolvedValue({ ...user, emailVerifiedAt: new Date(), pendingEmail: 'new@example.com' });

      await service.resend(user.id);

      expect(notifications.sendEmailVerification).toHaveBeenCalledWith(
        user.id,
        'new@example.com',
        expect.any(String),
        24,
      );
    });

    it('refuses when the email is already verified and nothing is pending', async () => {
      const { service, repository, notifications } = buildService();
      repository.findById.mockResolvedValue({ ...user, emailVerifiedAt: new Date() });

      await expect(service.resend(user.id)).rejects.toThrow(
        new BadRequestException('Your email address is already verified'),
      );
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('refuses a second email within a minute of the last one', async () => {
      const { service, repository, notifications } = buildService();
      const sentTenSecondsAgo = new Date(Date.now() - 10_000 + DAY_MS);
      repository.findById.mockResolvedValue({ ...user, emailVerificationTokenExp: sentTenSecondsAgo });

      await expect(service.resend(user.id)).rejects.toThrow(BadRequestException);
      expect(repository.saveEmailVerificationToken).not.toHaveBeenCalled();
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('allows another email once the minute has passed', async () => {
      const { service, repository } = buildService();
      const sentTwoMinutesAgo = new Date(Date.now() - 120_000 + DAY_MS);
      repository.findById.mockResolvedValue({ ...user, emailVerificationTokenExp: sentTwoMinutesAgo });

      await expect(service.resend(user.id)).resolves.toBe(true);
    });
  });

  describe('requestEmailChange', () => {
    it('stores the new address as pending, emails it a token and notifies the current address', async () => {
      const { service, repository, notifications } = buildService();
      const pending = { ...user, pendingEmail: 'new@example.com' };
      repository.findByEmail.mockResolvedValue(null);
      repository.saveEmailVerificationToken.mockResolvedValue(pending);

      await expect(service.requestEmailChange(user, 'new@example.com', { name: 'Ama' })).resolves.toEqual(pending);

      expect(repository.saveEmailVerificationToken).toHaveBeenCalledWith(
        user.id,
        { hash: expect.any(String), expiresAt: expect.any(Date) },
        { name: 'Ama', pendingEmail: 'new@example.com' },
        undefined,
      );
      expect(notifications.sendEmailVerification).toHaveBeenCalledWith(
        user.id,
        'new@example.com',
        expect.any(String),
        24,
      );
      expect(notifications.sendEmailChangeRequested).toHaveBeenCalledWith(user.id, user.email, 'new@example.com');
    });

    it("stores the pending address on the caller's transaction when given one", async () => {
      const { service, repository } = buildService();
      const tx = { id: 'tx' } as unknown as Prisma.TransactionClient;
      repository.findByEmail.mockResolvedValue(null);
      repository.saveEmailVerificationToken.mockResolvedValue({ ...user, pendingEmail: 'new@example.com' });

      await service.requestEmailChange(user, 'new@example.com', {}, tx);

      expect(repository.saveEmailVerificationToken).toHaveBeenCalledWith(
        user.id,
        expect.any(Object),
        { pendingEmail: 'new@example.com' },
        tx,
      );
    });

    it('refuses an address another account already uses', async () => {
      const { service, repository, notifications } = buildService();
      repository.findByEmail.mockResolvedValue({ ...user, id: 'someone-else', email: 'taken@example.com' });

      await expect(service.requestEmailChange(user, 'taken@example.com')).rejects.toThrow(ConflictException);
      expect(repository.saveEmailVerificationToken).not.toHaveBeenCalled();
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
      expect(notifications.sendEmailChangeRequested).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('looks the token up by its hash', async () => {
      const { service, repository } = buildService();
      repository.consumeEmailVerificationToken.mockResolvedValue({ status: 'email-changed', user });

      await expect(service.verify('raw-token')).resolves.toBe(true);

      expect(repository.consumeEmailVerificationToken).toHaveBeenCalledWith(sha256('raw-token'));
    });

    it('sends the welcome email after the first verification of a new account', async () => {
      const { service, repository, notifications } = buildService();
      repository.consumeEmailVerificationToken.mockResolvedValue({ status: 'verified', user, firstVerification: true });

      await service.verify('raw-token');

      expect(notifications.sendWelcomeEmail).toHaveBeenCalledWith(user.id, user.email, user.name);
    });

    it('does not send the welcome email again for a re-verification', async () => {
      const { service, repository, notifications } = buildService();
      repository.consumeEmailVerificationToken.mockResolvedValue({
        status: 'verified',
        user,
        firstVerification: false,
      });

      await service.verify('raw-token');

      expect(notifications.sendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('rejects an unknown, expired or used token', async () => {
      const { service, repository } = buildService();
      repository.consumeEmailVerificationToken.mockResolvedValue({ status: 'invalid' });

      await expect(service.verify('raw-token')).rejects.toThrow(
        new BadRequestException('Invalid or expired verification token'),
      );
    });

    it('reports a conflict when the pending address was taken before verification', async () => {
      const { service, repository } = buildService();
      repository.consumeEmailVerificationToken.mockResolvedValue({ status: 'email-taken' });

      await expect(service.verify('raw-token')).rejects.toThrow(ConflictException);
    });
  });
});
