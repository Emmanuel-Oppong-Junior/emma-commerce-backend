import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Order,
  OrderStatus,
  PaymentAttempt,
  PaymentIntentStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CHARGE_CURRENCY } from './constant';

/** A payment attempt in the shape the GraphQL `Payment` type exposes. */
export interface PaymentRecord {
  id: string;
  orderId: string;
  order?: Order;
  amount: Prisma.Decimal;
  currency: string;
  paymentMethod: string;
  status: PaymentStatus;
  transactionId: string | null;
  paymentDetails: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  deletedAt: Date | null;
}

export interface AttemptRequest {
  orderId: string;
  provider: PaymentProvider;
  channel: string;
  reference: string;
  idempotencyKey?: string;
}

export type OpenedAttempt =
  | { created: true; attempt: PaymentRecord }
  | { created: false; attempt: PaymentRecord; authorizationUrl: string | null };

const PAYABLE_ORDER = {
  user: { select: { email: true } },
  paymentIntent: { select: { status: true, attempts: { select: { status: true } } } },
} as const;

export type OrderForPayment = Prisma.OrderGetPayload<{ include: typeof PAYABLE_ORDER }>;

type AttemptWithIntent = PaymentAttempt & { intent: { orderId: string; order?: Order } };

const WITH_ORDER = { intent: { include: { order: true } } } as const;
const WITH_ORDER_ID = { intent: { select: { orderId: true } } } as const;

function toPaymentRecord(attempt: AttemptWithIntent): PaymentRecord {
  return {
    id: attempt.id,
    orderId: attempt.intent.orderId,
    ...(attempt.intent.order && { order: attempt.intent.order }),
    amount: attempt.amount,
    currency: attempt.currency,
    paymentMethod: attempt.channel,
    status: attempt.status,
    transactionId: attempt.reference,
    paymentDetails: attempt.providerDetails,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    deleted: attempt.deleted,
    deletedAt: attempt.deletedAt,
  };
}

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a new pending attempt for the order and abandons any other pending one, or returns the attempt already
   * opened under the same idempotency key. `assertPayable` re-checks the order under the lock and throws to refuse.
   */
  async openAttempt(
    request: AttemptRequest,
    assertPayable: (order: OrderForPayment | null) => asserts order is OrderForPayment,
  ): Promise<OpenedAttempt> {
    return this.prisma.$transaction(async (tx) => {
      // The row lock serialises initiations (and cancellation) of one order, so at most one attempt is live.
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${request.orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: request.orderId }, include: PAYABLE_ORDER });
      assertPayable(order);

      if (request.idempotencyKey) {
        const existing = await tx.paymentAttempt.findFirst({
          where: { idempotencyKey: request.idempotencyKey, intent: { orderId: request.orderId } },
          include: WITH_ORDER,
        });
        if (existing) {
          return { created: false, attempt: toPaymentRecord(existing), authorizationUrl: existing.authorizationUrl };
        }
      }

      const intent = await tx.paymentIntent.upsert({
        where: { orderId: request.orderId },
        create: { orderId: request.orderId, amount: order.totalAmount, currency: CHARGE_CURRENCY },
        update: {},
      });
      await tx.paymentAttempt.updateMany({
        where: { intentId: intent.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.ABANDONED },
      });
      const attempt = await tx.paymentAttempt.create({
        data: {
          intentId: intent.id,
          provider: request.provider,
          reference: request.reference,
          idempotencyKey: request.idempotencyKey,
          amount: intent.amount,
          currency: intent.currency,
          channel: request.channel,
          status: PaymentStatus.PENDING,
        },
        include: WITH_ORDER,
      });
      return { created: true, attempt: toPaymentRecord(attempt) };
    });
  }

  async recordCheckout(id: string, authorizationUrl: string, providerDetails: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.paymentAttempt.update({ where: { id }, data: { authorizationUrl, providerDetails } });
  }

  /** Fails an attempt the provider never opened, and frees its idempotency key so the same request can be retried. */
  async markInitializationFailed(id: string): Promise<void> {
    await this.prisma.paymentAttempt.updateMany({
      where: { id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED, rawStatus: 'initialize_failed', idempotencyKey: null },
    });
  }

  /** Records cash collected for a cash-on-delivery order as a completed attempt plus a cash collection. */
  async recordCashCollection(orderId: string, amount: Prisma.Decimal, recordedById: string): Promise<PaymentRecord> {
    const attempt = await this.prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.upsert({
        where: { orderId },
        create: { orderId, amount, status: PaymentIntentStatus.PAID },
        update: { status: PaymentIntentStatus.PAID },
      });
      const created = await tx.paymentAttempt.create({
        data: {
          intentId: intent.id,
          provider: PaymentProvider.CASH_ON_DELIVERY,
          amount,
          channel: PaymentProvider.CASH_ON_DELIVERY,
          status: PaymentStatus.COMPLETED,
        },
        include: WITH_ORDER,
      });
      await tx.cashCollection.create({ data: { orderId, attemptId: created.id, amount, recordedById } });
      return created;
    });
    return toPaymentRecord(attempt);
  }

  async findById(id: string): Promise<PaymentRecord | null> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id, deleted: false },
      include: WITH_ORDER,
    });
    return attempt && toPaymentRecord(attempt);
  }

  async findByReference(reference: string): Promise<PaymentRecord | null> {
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { reference, deleted: false },
      include: WITH_ORDER_ID,
    });
    return attempt && toPaymentRecord(attempt);
  }

  /**
   * The order's completed attempt if it has one, otherwise its newest attempt. A completed attempt wins over
   * newer ones so that a late success on a superseded reference still blocks a second charge.
   */
  async findByOrderId(orderId: string): Promise<PaymentRecord | null> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { intent: { orderId } },
      include: WITH_ORDER_ID,
      orderBy: { createdAt: 'desc' },
    });
    const current = attempts.find((a) => a.status === PaymentStatus.COMPLETED) ?? attempts[0];
    return current ? toPaymentRecord(current) : null;
  }

  async findAll(): Promise<PaymentRecord[]> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { deleted: false },
      include: WITH_ORDER,
      orderBy: { createdAt: 'desc' },
    });
    return attempts.map(toPaymentRecord);
  }

  async findByUser(userId: string): Promise<PaymentRecord[]> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { intent: { order: { userId } }, deleted: false },
      include: WITH_ORDER,
    });
    return attempts.map(toPaymentRecord);
  }

  async update(id: string, data: Prisma.PaymentAttemptUpdateInput): Promise<PaymentRecord> {
    try {
      return toPaymentRecord(await this.prisma.paymentAttempt.update({ where: { id }, data, include: WITH_ORDER }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Payment not found');
      }
      throw e;
    }
  }

  async findOrderWithUser(orderId: string): Promise<(Order & { user: { email: string } }) | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    }) as Promise<(Order & { user: { email: string } }) | null>;
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status },
    });
    return count > 0;
  }

  async forceUpdateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
  }

  async updatePaymentWithStatus(
    paymentId: string,
    status: PaymentStatus,
    paymentDetails: Prisma.InputJsonValue,
  ): Promise<PaymentRecord> {
    const attempt = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentAttempt.update({
        where: { id: paymentId },
        data: { status, providerDetails: paymentDetails },
        include: WITH_ORDER,
      });
      if (status === PaymentStatus.COMPLETED) {
        await tx.paymentIntent.update({ where: { id: updated.intentId }, data: { status: PaymentIntentStatus.PAID } });
      }
      return updated;
    });
    return toPaymentRecord(attempt);
  }
}
