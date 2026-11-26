import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma, Referral, ReferralStatus, VelocityLevel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { VelocityService } from '../fraud/velocity.service';
import { VelocityCheckpoint, VelocityEvent, velocitySubjects } from '../fraud/velocity-rules';
import { StoreFeaturesService } from '../store-features/store-features.service';
import {
  generateReferralCode,
  normaliseReferralCode,
  referralDisplayName,
  referralEntryRefusal,
} from './referral-rules';
import { CustomerReferrals, MyReferrals, StaffReferral } from './referrals.entities';

/** `extensions.reason` of the BAD_REQUEST for a referral code that names no customer. */
export const INVALID_REFERRAL_CODE = 'INVALID_REFERRAL_CODE';
const CODE_ATTEMPTS = 5;
const CONTEXT = 'Referrals';

/** A referral code checked before it is recorded: whose it is and whether its sign-ups are over the soft limit. */
export interface CheckedReferralCode {
  referrerId: string;
  flagged: boolean;
}

type ReferralWithReferee = Referral & { referee: { name: string | null } };

/**
 * Referrals (P6-L.2): codes, entering one (at sign-up or before the first order) and the views. Rewards are given and
 * taken back by the loyalty ledger when orders complete or are refunded.
 */
@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly velocity: VelocityService,
    private readonly logger: LoggerService,
    private readonly features: StoreFeaturesService,
  ) {}

  /** The user's referral code, created on first use (unique; a clash with another code is retried). */
  async codeFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (!user) throw new NotFoundException(`User "${userId}" not found`);
    if (user.referralCode) return user.referralCode;
    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      const code = generateReferralCode((size) => randomInt(size));
      try {
        const { count } = await this.prisma.user.updateMany({
          where: { id: userId, referralCode: null },
          data: { referralCode: code },
        });
        if (count === 1) return code;
        const current = await this.prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { referralCode: true },
        });
        return current.referralCode!;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      }
    }
    throw new Error(`Could not create a unique referral code for user "${userId}" in ${CODE_ATTEMPTS} attempts`);
  }

  /**
   * Finds the code's owner and screens their referral sign-ups: BAD_REQUEST with reason FEATURE_DISABLED while
   * referrals are switched off, INVALID_REFERRAL_CODE for a code nobody holds, FORBIDDEN with reason VELOCITY_LIMIT
   * above the hard limit. Records nothing.
   */
  async check(rawCode: string): Promise<CheckedReferralCode> {
    await this.features.assertEnabled('REFERRALS');
    const code = normaliseReferralCode(rawCode);
    const referrer =
      code && (await this.prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } }));
    if (!referrer) {
      throw new BadRequestException({
        message: 'That referral code does not exist',
        extensions: { reason: INVALID_REFERRAL_CODE },
      });
    }
    const hits = await this.velocity.screenOrRefuse(
      VelocityCheckpoint.REFERRAL_SIGNUP,
      velocitySubjects({ referrerId: referrer.id }),
    );
    return { referrerId: referrer.id, flagged: hits.some((hit) => hit.level === VelocityLevel.SOFT) };
  }

  /**
   * Records that `checked` referred the user, under the user's row lock: BAD_REQUEST with the ReferralEntryRefusal as
   * reason (their own code, already referred, an order already placed unless `atSignUp`, a mutual referral, a staff
   * account). At sign-up the new account may hold attached guest orders, which never count as a first order.
   */
  async enter(userId: string, checked: CheckedReferralCode, atSignUp = false): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const [customer, referrer] = await Promise.all([
        tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            referredBy: { select: { id: true } },
            storeMemberships: { select: { id: true } },
            _count: { select: { order: true } },
          },
        }),
        tx.user.findUniqueOrThrow({
          where: { id: checked.referrerId },
          select: { referredBy: { select: { referrerId: true } } },
        }),
      ]);
      const refusal = referralEntryRefusal({
        customerId: userId,
        referrerId: checked.referrerId,
        referrerReferredBy: referrer.referredBy?.referrerId ?? null,
        alreadyReferred: customer.referredBy !== null,
        hasOrders: !atSignUp && customer._count.order > 0,
        isStaff: customer.storeMemberships.length > 0,
      });
      if (refusal) {
        throw new BadRequestException({
          message: `This referral code cannot be used: ${refusal}`,
          extensions: { reason: refusal },
        });
      }
      await tx.referral.create({
        data: { referrerId: checked.referrerId, refereeId: userId, velocityFlagged: checked.flagged },
      });
    });
    if (checked.flagged) {
      this.logger.warn(
        `Referral flagged by velocity | referrerId: ${checked.referrerId} | refereeId: ${userId}`,
        CONTEXT,
      );
    }
    await this.velocity.record(VelocityEvent.REFERRAL_SIGNUP, velocitySubjects({ referrerId: checked.referrerId }));
  }

  /** applyReferralCode: check then enter, for a signed-in customer before their first order. */
  async apply(userId: string, rawCode: string): Promise<MyReferrals> {
    await this.enter(userId, await this.check(rawCode));
    return this.mine(userId);
  }

  /** The customer's code (created on first use), who referred them and their referrals, first names only. */
  async mine(userId: string): Promise<MyReferrals> {
    const code = await this.codeFor(userId);
    const [made, referredBy] = await Promise.all([
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include: { referee: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.referral.findUnique({
        where: { refereeId: userId },
        include: { referrer: { select: { name: true } } },
      }),
    ]);
    const rewarded = made.filter((referral) => referral.status === ReferralStatus.REWARDED);
    return {
      code,
      referredBy: referredBy && referralDisplayName(referredBy.referrer.name),
      pendingCount: made.filter((referral) => referral.status === ReferralStatus.PENDING).length,
      rewardedCount: rewarded.length,
      pointsEarned: rewarded.reduce((sum, referral) => sum + referral.referrerPoints, 0),
      referrals: made.map((referral) => ({
        displayName: referralDisplayName(referral.referee.name),
        status: referral.status,
        createdAt: referral.createdAt,
        rewardedAt: referral.rewardedAt,
      })),
    };
  }

  /** Staff view: the customer's code (not created here), the referral that brought them and the ones they made. */
  async forCustomer(userId: string): Promise<CustomerReferrals> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (!user) throw new NotFoundException(`User "${userId}" not found`);
    const include = { referee: { select: { name: true } } } as const;
    const [made, referredBy] = await Promise.all([
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.referral.findUnique({ where: { refereeId: userId }, include }),
    ]);
    return {
      code: user.referralCode,
      referredBy: referredBy && toStaffReferral(referredBy),
      referrals: made.map(toStaffReferral),
    };
  }
}

function toStaffReferral(referral: ReferralWithReferee): StaffReferral {
  return {
    id: referral.id,
    referrerId: referral.referrerId,
    refereeId: referral.refereeId,
    refereeDisplayName: referralDisplayName(referral.referee.name),
    status: referral.status,
    disqualifiedReason: referral.disqualifiedReason,
    velocityFlagged: referral.velocityFlagged,
    orderId: referral.orderId,
    referrerPoints: referral.referrerPoints,
    refereePoints: referral.refereePoints,
    createdAt: referral.createdAt,
    rewardedAt: referral.rewardedAt,
    reversedAt: referral.reversedAt,
  };
}
