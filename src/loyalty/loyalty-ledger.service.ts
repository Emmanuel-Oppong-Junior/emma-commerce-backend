import { ConflictException, Injectable } from '@nestjs/common';
import {
  LoyaltyTransactionType,
  OrderStatus,
  Prisma,
  ReferralStatus,
  RefundStatus,
  Store,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { PricingLoyalty } from '../pricing/points-redemption';
import { verifiedPhoneOf } from '../phone-verification/phone-otp';
import { referralDisqualification, shouldReverseReferral } from '../referrals/referral-rules';
import {
  addMonths,
  drawPoints,
  earnedPoints,
  earnRefusal,
  giveBackDraws,
  OrderLedger,
  orderSettlement,
  paidGoods,
  payDebtFirst,
  RecordedDraw,
  SpendableLot,
} from './loyalty-rules';

type Tx = Prisma.TransactionClient;

/** `extensions.reason` of the CONFLICT createOrder fails with when the customer's points changed since the quote. */
export const LOYALTY_BALANCE_CHANGED = 'LOYALTY_BALANCE_CHANGED';

export type LoyaltySettings = Pick<
  Store,
  | 'loyaltyEnabled'
  | 'loyaltyEarnPointsPerCedi'
  | 'loyaltyRedeemPointsPerCedi'
  | 'loyaltyMinRedeemPoints'
  | 'loyaltyMaxRedeemPercent'
  | 'loyaltyPointsExpiryMonths'
  | 'referralReferrerPoints'
  | 'referralNewCustomerPoints'
>;

export const LOYALTY_SETTINGS = {
  loyaltyEnabled: true,
  loyaltyEarnPointsPerCedi: true,
  loyaltyRedeemPointsPerCedi: true,
  loyaltyMinRedeemPoints: true,
  loyaltyMaxRedeemPercent: true,
  loyaltyPointsExpiryMonths: true,
  referralReferrerPoints: true,
  referralNewCustomerPoints: true,
} satisfies Prisma.StoreSelect;

const CONTEXT = 'LoyaltyLedger';

interface Credit {
  type:
    typeof LoyaltyTransactionType.EARN | typeof LoyaltyTransactionType.ADJUST | typeof LoyaltyTransactionType.REFERRAL;
  points: number;
  orderId?: string;
  referralId?: string;
  reason?: string;
  actorId?: string;
}

interface Debit {
  type: typeof LoyaltyTransactionType.REVERSE | typeof LoyaltyTransactionType.ADJUST;
  points: number;
  orderId?: string;
  referralId?: string;
  reason?: string;
  actorId?: string;
  /** Draw this lot first (a reversal takes back the order's own points first). */
  firstLotId?: string;
  /** What the lots cannot cover becomes debt; otherwise CONFLICT. */
  allowDebt: boolean;
}

/**
 * The loyalty ledger (P6-L.1). Every change runs on the caller's transaction under the account row lock: the balance
 * moves with one conditional update and one append-only LoyaltyTransaction, the lots with conditional updates, so the
 * balance always equals the lots' remaining points. Due lots expire first, so spending never touches expired points.
 */
@Injectable()
export class LoyaltyLedger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async settings(db: Tx = this.prisma): Promise<LoyaltySettings> {
    return db.store.findFirstOrThrow({ where: { singleton: true }, select: LOYALTY_SETTINGS });
  }

  /**
   * What checkout prices points with: the store's rules and the points the customer can spend. With `tx` (createOrder)
   * the account row is locked first and due lots expire, so the balance cannot change until the order commits.
   */
  async pricingFacts(userId: string, now: Date, tx?: Tx): Promise<PricingLoyalty> {
    const settings = await this.settings(tx);
    let balance: number;
    if (tx) {
      await this.lockAccount(tx, userId);
      balance = await this.expireDue(tx, userId, now);
    } else {
      const { _sum } = await this.prisma.loyaltyLot.aggregate({
        where: { userId, expiresAt: { gt: now } },
        _sum: { remaining: true },
      });
      balance = _sum.remaining ?? 0;
    }
    return {
      enabled: settings.loyaltyEnabled,
      balance,
      redeemPointsPerCedi: settings.loyaltyRedeemPointsPerCedi,
      minimumRedeemPoints: settings.loyaltyMinRedeemPoints,
      maxRedeemPercent: settings.loyaltyMaxRedeemPercent,
    };
  }

  /**
   * Spends `points` on the order (oldest expiry first) and records the REDEEM with the lots drawn. The caller locked
   * the account (pricingFacts with its tx); CONFLICT with reason LOYALTY_BALANCE_CHANGED when the lots fall short.
   */
  async redeem(tx: Tx, userId: string, orderId: string, points: number, now: Date): Promise<void> {
    const lots = await this.lockLots(tx, userId, now);
    const { draws, shortfall } = drawPoints(lots, points);
    if (shortfall > 0) throw balanceChanged();
    const expiries = new Map(lots.map((lot) => [lot.id, lot.expiresAt.toISOString()]));
    await this.takeFromLots(tx, draws);
    await this.moveBalance(tx, userId, -points, 0);
    const recorded: RecordedDraw[] = draws.map((draw) => ({ ...draw, expiresAt: expiries.get(draw.lotId)! }));
    await tx.loyaltyTransaction.create({
      data: { userId, type: LoyaltyTransactionType.REDEEM, points: -points, orderId, draws: recorded as never },
    });
  }

  /**
   * Brings the order's points up to date, on the caller's transaction: on completion (`completing`) the EARN, once
   * per order, unless earnRefusal says no; then earned points taken back and redeemed points given back for the goods
   * refunded so far, and every redeemed point given back once the order is cancelled or expired (orderSettlement).
   * The new customer's referral (P6-L.2) is rewarded on their first completed signed-in order and reversed when that
   * order is refunded in full within the return window. Repeating it changes nothing. Guest orders have no account and
   * are skipped.
   */
  async settleOrder(tx: Tx, orderId: string, now: Date, completing = false): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        userId: true,
        status: true,
        guestPhone: true,
        items: { select: { lineTotal: true, orderAdjustmentShare: true } },
      },
    });
    if (!order.userId) return;
    const userId = order.userId;
    await this.lockAccount(tx, userId);
    await this.expireDue(tx, userId, now);
    const paid = paidGoods(
      order.items.map((item) => ({
        lineTotal: item.lineTotal ?? new Prisma.Decimal(0),
        orderAdjustmentShare: item.orderAdjustmentShare,
      })),
    );
    if (completing && order.status === OrderStatus.COMPLETED)
      await this.earn(tx, userId, orderId, order.guestPhone, paid, now);

    const ledger = await this.orderLedger(tx, orderId);
    const { _sum } = await tx.refundLine.aggregate({
      where: { orderItem: { orderId }, refund: { status: RefundStatus.PROCESSED } },
      _sum: { amount: true },
    });
    const refunded = _sum.amount ?? new Prisma.Decimal(0);
    const { reverse, giveBack } = orderSettlement(ledger, { status: order.status, paid, refunded });
    if (reverse > 0) {
      const earnLot = await tx.loyaltyLot.findFirst({
        where: { transaction: { orderId, type: LoyaltyTransactionType.EARN } },
        select: { id: true },
      });
      await this.debit(tx, userId, now, {
        type: LoyaltyTransactionType.REVERSE,
        points: reverse,
        orderId,
        firstLotId: earnLot?.id,
        allowDebt: true,
      });
    }
    if (giveBack > 0) await this.giveBack(tx, userId, orderId, ledger.returned, giveBack, now);

    if (completing && order.status === OrderStatus.COMPLETED && order.guestPhone === null) {
      await this.rewardReferral(tx, userId, orderId, now);
    } else if (refunded.gt(0) && paid.gt(0)) {
      await this.reverseReferral(tx, orderId, refunded.gte(paid), now);
    }
  }

  /** A staff correction: positive adds a lot, negative takes points (CONFLICT when the balance cannot cover them). */
  async adjust(tx: Tx, userId: string, points: number, reason: string, actorId: string, now: Date): Promise<void> {
    await this.lockAccount(tx, userId);
    await this.expireDue(tx, userId, now);
    if (points > 0) {
      await this.credit(tx, userId, now, { type: LoyaltyTransactionType.ADJUST, points, reason, actorId });
    } else {
      await this.debit(tx, userId, now, {
        type: LoyaltyTransactionType.ADJUST,
        points: -points,
        reason,
        actorId,
        allowDebt: false,
      });
    }
  }

  /** Credits points as a new lot expiring after the store's expiry months; debt is paid off first. */
  async credit(tx: Tx, userId: string, now: Date, credit: Credit): Promise<void> {
    const { debt } = await this.lockAccount(tx, userId);
    const { repaid, kept } = payDebtFirst(credit.points, debt);
    await this.moveBalance(tx, userId, kept, -repaid);
    const transaction = await tx.loyaltyTransaction.create({
      data: {
        userId,
        type: credit.type,
        points: kept,
        debtChange: -repaid,
        orderId: credit.orderId,
        referralId: credit.referralId,
        reason: credit.reason,
        actorId: credit.actorId,
      },
    });
    if (kept === 0) return;
    const { loyaltyPointsExpiryMonths } = await this.settings(tx);
    await tx.loyaltyLot.create({
      data: {
        userId,
        transactionId: transaction.id,
        points: kept,
        remaining: kept,
        expiresAt: addMonths(now, loyaltyPointsExpiryMonths),
      },
    });
  }

  /**
   * Expires the user's lots past their expiry (one EXPIRE per lot, its remaining points) and returns the balance
   * left. The caller holds the account lock.
   */
  async expireDue(tx: Tx, userId: string, now: Date): Promise<number> {
    const due = await tx.$queryRaw<{ id: string; remaining: number }[]>`
      SELECT "id", "remaining" FROM "LoyaltyLot"
      WHERE "userId" = ${userId} AND "expiresAt" <= ${now} AND "remaining" > 0
      ORDER BY "expiresAt", "id" FOR UPDATE`;
    for (const lot of due) {
      await this.takeFromLots(tx, [{ lotId: lot.id, points: lot.remaining }]);
      await this.moveBalance(tx, userId, -lot.remaining, 0);
      await tx.loyaltyTransaction.create({
        data: { userId, type: LoyaltyTransactionType.EXPIRE, points: -lot.remaining, lotId: lot.id },
      });
    }
    const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { userId }, select: { balance: true } });
    return account.balance;
  }

  /** Creates the account when missing and locks its row; returns the balance and debt under the lock. */
  async lockAccount(tx: Tx, userId: string): Promise<{ balance: number; debt: number }> {
    await tx.$executeRaw`
      INSERT INTO "LoyaltyAccount" ("userId", "updatedAt") VALUES (${userId}, CURRENT_TIMESTAMP)
      ON CONFLICT ("userId") DO NOTHING`;
    const [account] = await tx.$queryRaw<{ balance: number; debt: number }[]>`
      SELECT "balance", "debt" FROM "LoyaltyAccount" WHERE "userId" = ${userId} FOR UPDATE`;
    return account;
  }

  private async earn(
    tx: Tx,
    userId: string,
    orderId: string,
    guestPhone: string | null,
    paid: Prisma.Decimal,
    now: Date,
  ): Promise<void> {
    const already = await tx.loyaltyTransaction.findFirst({
      where: { orderId, type: LoyaltyTransactionType.EARN },
      select: { id: true },
    });
    if (already) return;
    const settings = await this.settings(tx);
    const memberships = await tx.storeMembership.count({ where: { userId } });
    const refusal = earnRefusal({ guestPhone, isStaff: memberships > 0, enabled: settings.loyaltyEnabled });
    if (refusal) {
      this.logger.log(`Order earns no loyalty points | orderId: ${orderId} | reason: ${refusal}`, CONTEXT);
      return;
    }
    const points = earnedPoints(paid, settings.loyaltyEarnPointsPerCedi);
    if (points > 0) await this.credit(tx, userId, now, { type: LoyaltyTransactionType.EARN, points, orderId });
  }

  private async debit(tx: Tx, userId: string, now: Date, debit: Debit): Promise<void> {
    const lots = await this.lockLots(tx, userId, now);
    const { draws, shortfall } = drawPoints(lots, debit.points, debit.firstLotId);
    if (shortfall > 0 && !debit.allowDebt) {
      throw new ConflictException({
        message: `The customer has ${debit.points - shortfall} points; ${debit.points} cannot be taken`,
        extensions: { reason: 'INSUFFICIENT_POINTS' },
      });
    }
    const fromBalance = debit.points - shortfall;
    await this.takeFromLots(tx, draws);
    await this.moveBalance(tx, userId, -fromBalance, shortfall);
    await tx.loyaltyTransaction.create({
      data: {
        userId,
        type: debit.type,
        points: -fromBalance,
        debtChange: shortfall,
        orderId: debit.orderId,
        referralId: debit.referralId,
        reason: debit.reason,
        actorId: debit.actorId,
      },
    });
  }

  /** Puts redeemed points back into the lots they came from; points landing in a lot past its expiry expire at once. */
  private async giveBack(
    tx: Tx,
    userId: string,
    orderId: string,
    alreadyReturned: number,
    points: number,
    now: Date,
  ): Promise<void> {
    const redemption = await tx.loyaltyTransaction.findFirstOrThrow({
      where: { orderId, type: LoyaltyTransactionType.REDEEM },
      select: { draws: true },
    });
    const back = giveBackDraws(redemption.draws as unknown as RecordedDraw[], alreadyReturned, points);
    for (const draw of back) {
      await tx.loyaltyLot.update({ where: { id: draw.lotId }, data: { remaining: { increment: draw.points } } });
    }
    await this.moveBalance(tx, userId, points, 0);
    await tx.loyaltyTransaction.create({
      data: { userId, type: LoyaltyTransactionType.REDEEM_RETURN, points, orderId },
    });
    await this.expireDue(tx, userId, now);
  }

  private async orderLedger(tx: Tx, orderId: string): Promise<OrderLedger> {
    const rows = await tx.loyaltyTransaction.groupBy({
      by: ['type'],
      where: { orderId, referralId: null },
      _sum: { points: true, debtChange: true },
    });
    const sum = (type: LoyaltyTransactionType) => rows.find((row) => row.type === type)?._sum;
    return {
      earned: sum(LoyaltyTransactionType.EARN)?.points ?? 0,
      reversed:
        -(sum(LoyaltyTransactionType.REVERSE)?.points ?? 0) + (sum(LoyaltyTransactionType.REVERSE)?.debtChange ?? 0),
      redeemed: -(sum(LoyaltyTransactionType.REDEEM)?.points ?? 0),
      returned: sum(LoyaltyTransactionType.REDEEM_RETURN)?.points ?? 0,
    };
  }

  /**
   * The first signed-in order of a referred customer completed: their PENDING referral is rewarded (both accounts get
   * REFERRAL points; a staff referrer gets none) or disqualified (referralDisqualification). The conditional status
   * update makes it happen once; later orders find the referral settled.
   */
  private async rewardReferral(tx: Tx, refereeId: string, orderId: string, now: Date): Promise<void> {
    const referral = await tx.referral.findUnique({ where: { refereeId } });
    if (referral?.status !== ReferralStatus.PENDING) return;
    const settings = await this.settings(tx);
    const phones = { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedNumber: true } as const;
    const referee = await tx.user.findUniqueOrThrow({ where: { id: refereeId }, select: phones });
    const referrer = await tx.user.findUniqueOrThrow({
      where: { id: referral.referrerId },
      select: { ...phones, storeMemberships: { select: { id: true } } },
    });
    const disqualified = referralDisqualification({
      refereeVerifiedPhone: verifiedPhoneOf(referee),
      referrerPhones: [referrer.phoneNumber, referrer.phoneVerifiedNumber],
      loyaltyEnabled: settings.loyaltyEnabled,
    });
    if (disqualified) {
      await tx.referral.updateMany({
        where: { id: referral.id, status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.DISQUALIFIED, orderId, disqualifiedReason: disqualified },
      });
      this.logger.log(`Referral not rewarded | referralId: ${referral.id} | reason: ${disqualified}`, CONTEXT);
      return;
    }
    const referrerPoints = referrer.storeMemberships.length > 0 ? 0 : settings.referralReferrerPoints;
    const refereePoints = settings.referralNewCustomerPoints;
    const { count } = await tx.referral.updateMany({
      where: { id: referral.id, status: ReferralStatus.PENDING },
      data: { status: ReferralStatus.REWARDED, orderId, rewardedAt: now, referrerPoints, refereePoints },
    });
    if (count === 0) return;
    const reward = { type: LoyaltyTransactionType.REFERRAL, orderId, referralId: referral.id } as const;
    if (refereePoints > 0) await this.credit(tx, refereeId, now, { ...reward, points: refereePoints });
    if (referrerPoints > 0) await this.credit(tx, referral.referrerId, now, { ...reward, points: referrerPoints });
  }

  /** A rewarded referral whose qualifying order was refunded in full within the return window loses its rewards. */
  private async reverseReferral(tx: Tx, orderId: string, fullyRefunded: boolean, now: Date): Promise<void> {
    const referral = await tx.referral.findFirst({ where: { orderId, status: ReferralStatus.REWARDED } });
    if (!referral?.rewardedAt) return;
    const { returnWindowDays } = await tx.store.findFirstOrThrow({
      where: { singleton: true },
      select: { returnWindowDays: true },
    });
    if (!shouldReverseReferral({ fullyRefunded, rewardedAt: referral.rewardedAt, now, returnWindowDays })) return;
    const { count } = await tx.referral.updateMany({
      where: { id: referral.id, status: ReferralStatus.REWARDED },
      data: { status: ReferralStatus.REVERSED, reversedAt: now },
    });
    if (count === 0) return;
    const reversal = {
      type: LoyaltyTransactionType.REVERSE,
      orderId,
      referralId: referral.id,
      allowDebt: true,
    } as const;
    if (referral.refereePoints > 0) {
      await this.debit(tx, referral.refereeId, now, { ...reversal, points: referral.refereePoints });
    }
    if (referral.referrerPoints > 0) {
      await this.lockAccount(tx, referral.referrerId);
      await this.debit(tx, referral.referrerId, now, { ...reversal, points: referral.referrerPoints });
    }
  }

  /** The user's unexpired lots with points left, locked. */
  private async lockLots(tx: Tx, userId: string, now: Date): Promise<SpendableLot[]> {
    return tx.$queryRaw<SpendableLot[]>`
      SELECT "id", "remaining", "expiresAt", "createdAt" FROM "LoyaltyLot"
      WHERE "userId" = ${userId} AND "expiresAt" > ${now} AND "remaining" > 0
      ORDER BY "id" FOR UPDATE`;
  }

  private async takeFromLots(tx: Tx, draws: readonly { lotId: string; points: number }[]): Promise<void> {
    for (const draw of draws) {
      const { count } = await tx.loyaltyLot.updateMany({
        where: { id: draw.lotId, remaining: { gte: draw.points } },
        data: { remaining: { decrement: draw.points } },
      });
      if (count === 0) throw balanceChanged();
    }
  }

  /** Conditional: the balance never goes below zero (also a CHECK), nor the debt. */
  private async moveBalance(tx: Tx, userId: string, points: number, debtChange: number): Promise<void> {
    const { count } = await tx.loyaltyAccount.updateMany({
      where: {
        userId,
        ...(points < 0 && { balance: { gte: -points } }),
        ...(debtChange < 0 && { debt: { gte: -debtChange } }),
      },
      data: { balance: { increment: points }, debt: { increment: debtChange } },
    });
    if (count === 0) throw balanceChanged();
  }
}

function balanceChanged(): ConflictException {
  return new ConflictException({
    message: 'Your loyalty points changed since the quote: get a new checkoutQuote',
    extensions: { reason: LOYALTY_BALANCE_CHANGED },
  });
}
