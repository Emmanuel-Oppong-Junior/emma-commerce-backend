import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RefreshToken, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type RefreshRotationOutcome = 'rotated' | 'reused' | 'invalid';

// A replay this soon after the token was rotated is a simultaneous refresh (two tabs), not theft.
const CONCURRENT_REFRESH_GRACE_MS = 10_000;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.UserCreateInput): Promise<User> {
    try {
      return await this.prisma.user.create({ data });
    } catch (e) {
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
  ): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: email as string,
        name,
        profilePicture,
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

  async update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    try {
      return await this.prisma.user.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }

  async delete(id: string): Promise<User> {
    try {
      return await this.prisma.user.delete({ where: { id } });
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

  /** Applies the update and revokes every refresh token of the user in the same transaction. */
  async updateAndRevokeSessions(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    try {
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
}
