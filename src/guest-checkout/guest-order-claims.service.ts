import { BadRequestException, ConflictException, Injectable, Module } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { CommonsModule } from '../commons/commons.module';
import { claimsGuestOrder, GuestClaimRefusal, signUpPhoneClaim } from './guest-order-claims';
import { GuestOrderAccess, GuestOrderAccessModule } from './guest-order-access';

const CONTEXT = 'GuestOrderClaims';

const REFUSAL_MESSAGES: Record<GuestClaimRefusal, string> = {
  INVALID_GUEST_ORDER_TOKEN: 'The guest order link is not valid',
  GUEST_VERIFICATION_EXPIRED:
    'The phone was verified for that guest order too long ago: sign up without it, then verify your phone',
  PHONE_IN_USE: 'Another account already uses the phone number of that guest order',
};

/**
 * Attaches guest orders (P6-G.1) to the account that now holds their verified phone: when an account verifies its
 * phone, and at a sign-up that brings a guest order token. Each order moves with a conditional update (still without
 * an account), together with its promotion redemptions and its notification rows, so a repeat attaches nothing.
 */
@Injectable()
export class GuestOrderClaims {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GuestOrderAccess,
    private readonly logger: LoggerService,
  ) {}

  /**
   * The verified phone a sign-up takes over from the guest order its token names (signUpPhoneClaim). BAD_REQUEST
   * with reason INVALID_GUEST_ORDER_TOKEN or GUEST_VERIFICATION_EXPIRED, CONFLICT with reason PHONE_IN_USE.
   */
  async phoneClaimForSignUp(guestOrderToken: string, now = new Date()): Promise<{ phone: string; verifiedAt: Date }> {
    const orderId = this.access.orderIdOf(guestOrderToken);
    const order = orderId
      ? await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { guestPhone: true, guestPhoneVerifiedAt: true },
        })
      : null;
    const holder = order?.guestPhone
      ? await this.prisma.user.findUnique({ where: { phoneNumber: order.guestPhone }, select: { id: true } })
      : null;
    const claim = signUpPhoneClaim(order, holder !== null, now);
    if ('refused' in claim) {
      const body = { message: REFUSAL_MESSAGES[claim.refused], extensions: { reason: claim.refused } };
      throw claim.refused === GuestClaimRefusal.PHONE_IN_USE
        ? new ConflictException(body)
        : new BadRequestException(body);
    }
    return claim;
  }

  /** Returns the ids of the orders attached now. */
  async attachToAccount(userId: string, verifiedPhone: string, db?: Prisma.TransactionClient): Promise<string[]> {
    const attach = async (tx: Prisma.TransactionClient) => {
      const candidates = await tx.order.findMany({
        where: { userId: null, guestPhone: verifiedPhone },
        select: { id: true, userId: true, guestPhone: true },
        orderBy: { id: 'asc' },
      });
      const attached: string[] = [];
      for (const order of candidates.filter((candidate) => claimsGuestOrder(candidate, verifiedPhone))) {
        const { count } = await tx.order.updateMany({ where: { id: order.id, userId: null }, data: { userId } });
        if (count === 1) attached.push(order.id);
      }
      if (attached.length === 0) return attached;
      await tx.redemption.updateMany({
        where: { orderId: { in: attached }, customerId: null },
        data: { customerId: userId },
      });
      await tx.notification.updateMany({
        where: { userId: null, refType: 'Order', refId: { in: attached } },
        data: { userId },
      });
      return attached;
    };
    const attached = db ? await attach(db) : await this.prisma.$transaction(attach);
    if (attached.length > 0) {
      this.logger.log(
        `Guest orders attached to account | userId: ${userId} | count: ${attached.length} | orderIds: ${attached.join(',')}`,
        CONTEXT,
      );
    }
    return attached;
  }
}

@Module({
  imports: [CommonsModule, GuestOrderAccessModule],
  providers: [GuestOrderClaims],
  exports: [GuestOrderClaims],
})
export class GuestOrderClaimsModule {}
