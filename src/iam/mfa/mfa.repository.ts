import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMfaState(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, mfaSecret: true, mfaEnabledAt: true, mfaLastUsedStep: true },
    });
  }

  async findIssuerName(): Promise<string> {
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { singleton: true },
      select: { tradingName: true },
    });
    return store.tradingName;
  }

  /** Stores a new, not yet confirmed secret; refuses (false) if MFA is already enabled. */
  async savePendingSecret(userId: string, sealedSecret: string): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, mfaEnabledAt: null },
      data: { mfaSecret: sealedSecret, mfaLastUsedStep: null },
    });
    return count === 1;
  }

  /**
   * Records `step` as used if it is newer than the last used one. Two requests with the same code race on the row
   * lock and only one matches, so a code is accepted at most once.
   */
  async claimTimeStep(userId: string, step: number, db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const { count } = await db.user.updateMany({
      where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
      data: { mfaLastUsedStep: step },
    });
    return count === 1;
  }

  /** Marks an unused recovery code used, exactly once. */
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const { count } = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  /** Turns MFA on and replaces any earlier recovery codes, only if the user is still in the pending state. */
  async enable(tx: Prisma.TransactionClient, userId: string, codeHashes: string[], enabledAt: Date): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, mfaEnabledAt: null, mfaSecret: { not: null } },
      data: { mfaEnabledAt: enabledAt },
    });
    if (count !== 1) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userId, codeHash })) });
    return true;
  }
}
