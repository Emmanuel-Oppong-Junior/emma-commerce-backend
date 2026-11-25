import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, fieldChanges } from '../commons/audit.service';
import { StoreFeaturesService } from '../store-features/store-features.service';
import { LOYALTY_SETTINGS, LoyaltyLedger, LoyaltySettings } from './loyalty-ledger.service';
import {
  AdjustLoyaltyPointsInput,
  LoyaltySettingsEntity,
  LoyaltySummary,
  LoyaltyTransactionEntity,
  UpdateLoyaltySettingsInput,
} from './loyalty.entities';

const SETTINGS_FIELDS = Object.keys(LOYALTY_SETTINGS) as (keyof LoyaltySettings)[];

function toSettings(settings: LoyaltySettings, enabled: boolean): LoyaltySettingsEntity {
  return {
    enabled,
    earnPointsPerCedi: settings.loyaltyEarnPointsPerCedi,
    redeemPointsPerCedi: settings.loyaltyRedeemPointsPerCedi,
    minimumRedeemPoints: settings.loyaltyMinRedeemPoints,
    maxRedeemPercent: settings.loyaltyMaxRedeemPercent,
    pointsExpiryMonths: settings.loyaltyPointsExpiryMonths,
    referrerRewardPoints: settings.referralReferrerPoints,
    newCustomerRewardPoints: settings.referralNewCustomerPoints,
  };
}

/** Loyalty reads and staff operations (P6-L.1); the ledger itself is LoyaltyLedger. */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LoyaltyLedger,
    private readonly audit: AuditService,
    private readonly features: StoreFeaturesService,
  ) {}

  /**
   * The user's spendable points (lots not yet expired, so a lot past its expiry no longer counts before the expiry job
   * records it), the points owed, the next expiry and a page of history, newest first.
   */
  async summary(userId: string, first: number, after?: string, now = new Date()): Promise<LoyaltySummary> {
    const account = await this.prisma.loyaltyAccount.findUnique({ where: { userId }, select: { debt: true } });
    const live = { userId, expiresAt: { gt: now }, remaining: { gt: 0 } };
    const { _sum } = await this.prisma.loyaltyLot.aggregate({ where: live, _sum: { remaining: true } });
    const soonest = await this.prisma.loyaltyLot.findFirst({ where: live, orderBy: { expiresAt: 'asc' } });
    const expiring =
      soonest &&
      (await this.prisma.loyaltyLot.aggregate({
        where: { ...live, expiresAt: soonest.expiresAt },
        _sum: { remaining: true },
      }));
    return {
      balance: _sum.remaining ?? 0,
      pointsOwed: account?.debt ?? 0,
      nextExpiry: soonest && { points: expiring?._sum.remaining ?? 0, expiresAt: soonest.expiresAt },
      history: await this.history(userId, first, after),
    };
  }

  /** summary for staff: NOT_FOUND for an unknown user. */
  async customerSummary(userId: string, first: number, after?: string): Promise<LoyaltySummary> {
    await this.findUser(userId);
    return this.summary(userId, first, after);
  }

  /**
   * Adds or takes a customer's points with a reason, audited. Staff accounts collect no points (BAD_REQUEST); taking
   * more than the balance is CONFLICT (reason INSUFFICIENT_POINTS).
   */
  async adjust(input: AdjustLoyaltyPointsInput, actorId: string): Promise<LoyaltySummary> {
    const user = await this.findUser(input.userId);
    if (user.storeMemberships.length > 0) {
      throw new BadRequestException(`User "${input.userId}" is a staff account; staff do not collect loyalty points`);
    }
    await this.audit.record(
      (tx) => this.ledger.adjust(tx, input.userId, input.points, input.reason, actorId, new Date()),
      () => ({
        entity: 'LoyaltyAccount',
        entityId: input.userId,
        action: 'UPDATE',
        userId: actorId,
        details: { points: input.points, reason: input.reason },
      }),
    );
    return this.summary(input.userId, 20);
  }

  async settings(): Promise<LoyaltySettingsEntity> {
    return toSettings(await this.ledger.settings(), await this.features.isEnabled('LOYALTY'));
  }

  async updateSettings(input: UpdateLoyaltySettingsInput, actorId: string): Promise<LoyaltySettingsEntity> {
    const data: Prisma.StoreUpdateInput = {
      loyaltyEarnPointsPerCedi: input.earnPointsPerCedi,
      loyaltyRedeemPointsPerCedi: input.redeemPointsPerCedi,
      loyaltyMinRedeemPoints: input.minimumRedeemPoints,
      loyaltyMaxRedeemPercent: input.maxRedeemPercent,
      loyaltyPointsExpiryMonths: input.pointsExpiryMonths,
      referralReferrerPoints: input.referrerRewardPoints,
      referralNewCustomerPoints: input.newCustomerRewardPoints,
    };
    const { after } = await this.audit.record(
      async (tx) => {
        const before = await this.ledger.settings(tx);
        const store = await tx.store.update({ where: { singleton: true }, data, select: { id: true } });
        return { before, after: await this.ledger.settings(tx), storeId: store.id };
      },
      ({ before, after, storeId }) => ({
        entity: 'Store',
        entityId: storeId,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(before, after, SETTINGS_FIELDS) },
      }),
    );
    return toSettings(after, await this.features.isEnabled('LOYALTY'));
  }

  private async history(userId: string, first: number, after?: string) {
    const cursor =
      after &&
      (await this.prisma.loyaltyTransaction.findFirst({
        where: { id: after, userId },
        select: { id: true, createdAt: true },
      }));
    if (after && !cursor) throw new BadRequestException(`Unknown cursor "${after}"`);
    const where: Prisma.LoyaltyTransactionWhereInput = { userId };
    const [rows, totalCount] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({
        where: cursor
          ? {
              ...where,
              OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
            }
          : where,
        include: { creditedLot: { select: { expiresAt: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: first + 1,
      }),
      this.prisma.loyaltyTransaction.count({ where }),
    ]);
    const nodes: LoyaltyTransactionEntity[] = rows.slice(0, first).map((row) => ({
      id: row.id,
      type: row.type,
      points: row.points,
      debtChange: row.debtChange,
      orderId: row.orderId,
      reason: row.reason,
      expiresAt: row.creditedLot?.expiresAt ?? null,
      createdAt: row.createdAt,
    }));
    return { nodes, totalCount, hasNextPage: rows.length > first };
  }

  private async findUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, storeMemberships: { select: { id: true } } },
    });
    if (!user) throw new NotFoundException(`User "${userId}" not found`);
    return user;
  }
}
