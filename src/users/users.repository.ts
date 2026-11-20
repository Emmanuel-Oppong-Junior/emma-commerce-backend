import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RefreshToken, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { uniqueViolationFields } from '../commons/filters/error-classification';

export type RefreshRotationOutcome = 'rotated' | 'reused' | 'invalid';

export type EmailVerificationOutcome =
  | { status: 'invalid' }
  | { status: 'email-taken' }
  | { status: 'verified'; user: User; firstVerification: boolean }
  | { status: 'email-changed'; user: User };

// A replay this soon after the token was rotated is a simultaneous refresh (two tabs), not theft.
const CONCURRENT_REFRESH_GRACE_MS = 10_000;

const PHONE_IN_USE_MESSAGE = 'Phone number is already in use';

function isPhoneNumberTaken(error: unknown): boolean {
  return uniqueViolationFields(error)?.includes('phoneNumber') ?? false;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.UserCreateInput, db: Prisma.TransactionClient = this.prisma): Promise<User> {
    try {
      return await db.user.create({ data });
    } catch (e) {
      if (isPhoneNumberTaken(e)) throw new ConflictException(PHONE_IN_USE_MESSAGE);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw e;
    }
  }

  async createWithAuthProvider(
    email: string | undefined,
    name: string | undefined,
    profilePicture: string | undefined,
    providerId: string,
    provider: string,
    emailVerifiedAt: Date | null,
  ): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: email as string,
        name,
        profilePicture,
        emailVerifiedAt,
        authProvider: { create: { providerId, provider } },
      },
    });
  }

  async createAuthProvider(userId: string, providerId: string, provider: string): Promise<void> {
    await this.prisma.authProvider.create({ data: { userId, providerId, provider } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findByProviderId(providerId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { authProvider: { some: { providerId } } },
    });
  }

  async findWithRelations(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: { addresses: true, cart: true, wishlist: true, order: true },
    });
  }

  async findMany(
    options: {
      take: number;
      skip: number;
      cursor?: { id: string };
      orderBy?: string;
      orderInAsc?: boolean;
    },
    where: Prisma.UserWhereInput,
  ): Promise<User[]> {
    return this.prisma.user.findMany({
      take: options.take,
      skip: options.skip,
      cursor: options.cursor,
      where,
      orderBy: options.orderBy ? { [options.orderBy]: options.orderInAsc ? 'asc' : 'desc' } : { name: 'asc' },
    });
  }

  async count(where: Prisma.UserWhereInput): Promise<number> {
    return this.prisma.user.count({ where });
  }

  async update(id: string, data: Prisma.UserUpdateInput, db: Prisma.TransactionClient = this.prisma): Promise<User> {
    try {
      return await db.user.update({ where: { id }, data });
    } catch (e) {
      if (isPhoneNumberTaken(e)) throw new ConflictException(PHONE_IN_USE_MESSAGE);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<User> {
    try {
      return await db.user.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }

  // Refresh token operations

  async findRefreshToken(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.prisma.refreshToken.update({ where: { tokenHash }, data: { revoked: true } });
  }

  /**
   * Revokes the presented token and stores its replacement in one transaction, but only if the presented
   * token is still live. A token that was already rotated or revoked is treated as stolen: every refresh
   * token the user holds is revoked.
   */
  async rotateRefreshToken(
    oldTokenHash: string,
    userId: string,
    newTokenHash: string,
    expiresAt: Date,
  ): Promise<RefreshRotationOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Concurrent rotations of one token queue on the row lock and re-check revoked=false, so only one matches.
      const { count } = await tx.refreshToken.updateMany({
        where: { tokenHash: oldTokenHash, userId, revoked: false, expiresAt: { gt: now } },
        data: { revoked: true },
      });
      if (count === 0) {
        const presented = await tx.refreshToken.findUnique({ where: { tokenHash: oldTokenHash } });
        if (!presented?.revoked || presented.userId !== userId) return 'invalid';
        const justRotated = await tx.refreshToken.count({
          where: { userId, revoked: false, createdAt: { gte: new Date(now.getTime() - CONCURRENT_REFRESH_GRACE_MS) } },
        });
        if (justRotated > 0) return 'invalid';
        await tx.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
        return 'reused';
      }
      await tx.refreshToken.deleteMany({ where: { userId, expiresAt: { lt: now } } });
      await tx.refreshToken.create({ data: { userId, tokenHash: newTokenHash, expiresAt } });
      return 'rotated';
    });
  }

  /** Applies the update and revokes every refresh token of the user in one transaction (the caller's `tx` if given). */
  async updateAndRevokeSessions(
    id: string,
    data: Prisma.UserUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<User> {
    try {
      if (tx) {
        const user = await tx.user.update({ where: { id }, data });
        await tx.refreshToken.updateMany({ where: { userId: id, revoked: false }, data: { revoked: true } });
        return user;
      }
      const [user] = await this.prisma.$transaction([
        this.prisma.user.update({ where: { id }, data }),
        this.prisma.refreshToken.updateMany({ where: { userId: id, revoked: false }, data: { revoked: true } }),
      ]);
      return user;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }

  async revokeRefreshTokensByHash(tokenHash: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash }, data: { revoked: true } });
  }

  async deleteExpiredRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });
  }

  async createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  }

  // Password reset operations

  async savePasswordResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordResetToken: tokenHash, passwordResetTokenExp: expiresAt },
    });
  }

  async findByResetToken(tokenHash: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { passwordResetToken: tokenHash, passwordResetTokenExp: { gt: new Date() } },
    });
  }

  async clearPasswordResetToken(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordResetToken: null, passwordResetTokenExp: null },
    });
  }

  // Email verification operations

  /** Stores the hash of a new verification token (replacing any earlier one) and, for an email change, the pending address. */
  async saveEmailVerificationToken(
    userId: string,
    token: { hash: string; expiresAt: Date },
    data: Prisma.UserUpdateInput = {},
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<User> {
    return this.update(
      userId,
      { ...data, emailVerificationToken: token.hash, emailVerificationTokenExp: token.expiresAt },
      db,
    );
  }

  /**
   * Consumes a live verification token exactly once. Without a pending email it marks the current email verified;
   * with one it switches the account to the pending email and revokes every session, unless another account
   * took that address in the meantime, in which case the pending change is dropped.
   */
  async consumeEmailVerificationToken(tokenHash: string): Promise<EmailVerificationOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<EmailVerificationOutcome> => {
        const now = new Date();
        const user = await tx.user.findFirst({
          where: { emailVerificationToken: tokenHash, emailVerificationTokenExp: { gt: now } },
        });
        if (!user) return { status: 'invalid' };

        // Concurrent verifications queue on the row lock and re-check the token, so only one claim matches.
        const claim = { id: user.id, emailVerificationToken: tokenHash };
        const clearToken = { emailVerificationToken: null, emailVerificationTokenExp: null };
        const { pendingEmail } = user;

        if (!pendingEmail) {
          const { count } = await tx.user.updateMany({ where: claim, data: { ...clearToken, emailVerifiedAt: now } });
          if (count !== 1) return { status: 'invalid' };
          return {
            status: 'verified',
            user: { ...user, ...clearToken, emailVerifiedAt: now },
            firstVerification: !user.emailVerifiedAt,
          };
        }

        if (await tx.user.findUnique({ where: { email: pendingEmail } })) {
          await tx.user.updateMany({ where: claim, data: { ...clearToken, pendingEmail: null } });
          return { status: 'email-taken' };
        }
        const changed = { ...clearToken, email: pendingEmail, pendingEmail: null, emailVerifiedAt: now };
        const { count } = await tx.user.updateMany({ where: claim, data: changed });
        if (count !== 1) return { status: 'invalid' };
        await tx.refreshToken.updateMany({ where: { userId: user.id, revoked: false }, data: { revoked: true } });
        return { status: 'email-changed', user: { ...user, ...changed } };
      });
    } catch (e) {
      // Another account claimed the address between the check and the switch.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { status: 'email-taken' };
      throw e;
    }
  }
}
