import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { LoyaltyLedger } from './loyalty-ledger.service';

export const LOYALTY_EXPIRY_LOCK_KEY = 70_412_010;
/** Customers handled per run; the rest wait for the next run. */
export const LOYALTY_EXPIRY_BATCH = 500;
const MAX_RUN_MS = 10 * 60 * 1000;
const CONTEXT = 'LoyaltyExpiryTask';

/**
 * Repeatable job (daily): records an EXPIRE for every lot past its expiry with points left, one customer per
 * transaction under their account lock. Spending and refunds expire a customer's due lots themselves first, so this
 * only catches up the balances nobody touched. An advisory lock keeps overlapping runs out.
 */
@Injectable()
export class LoyaltyExpiryTask {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LoyaltyLedger,
    private readonly logger: LoggerService,
  ) {}

  async expire(now = new Date()): Promise<number | null> {
    const expired = await this.prisma.$transaction(
      async (lockTx) => {
        const [{ locked }] = await lockTx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${LOYALTY_EXPIRY_LOCK_KEY}::bigint) AS locked`;
        if (!locked) return null;
        const due = await this.prisma.loyaltyLot.findMany({
          where: { expiresAt: { lte: now }, remaining: { gt: 0 } },
          distinct: ['userId'],
          select: { userId: true },
          orderBy: { userId: 'asc' },
          take: LOYALTY_EXPIRY_BATCH,
        });
        for (const { userId } of due) {
          await this.prisma.$transaction(async (tx) => {
            await this.ledger.lockAccount(tx, userId);
            await this.ledger.expireDue(tx, userId, now);
          });
        }
        return due.length;
      },
      { timeout: MAX_RUN_MS },
    );
    if (expired === null) {
      this.logger.log('Skipped: another instance is already expiring loyalty points', CONTEXT);
      return null;
    }
    this.logger.log(`Loyalty points expired | customers: ${expired}`, CONTEXT);
    return expired;
  }
}
