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

export interface NewPaymentAttempt {
  orderId: string;
  provider: PaymentProvider;
  amount: number | Prisma.Decimal;
  currency: string;
  channel: string;
  status: PaymentStatus;
  reference?: string;
  providerDetails?: Prisma.InputJsonValue;
}

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

  /** Records a new attempt, opening the order's payment intent on its first attempt. */
  async create(input: NewPaymentAttempt): Promise<PaymentRecord> {
    const attempt = await this.prisma.$transaction(async (tx) => {
      const intent = await tx.paymentIntent.upsert({
        where: { orderId: input.orderId },
        create: { orderId: input.orderId, amount: input.amount, currency: input.currency },
        update: {},
      });
      return tx.paymentAttempt.create({
        data: {
          intentId: intent.id,
          provider: input.provider,
          reference: input.reference,
          amount: input.amount,
          currency: input.currency,
          channel: input.channel,
          status: input.status,
          providerDetails: input.providerDetails,
        },
        include: WITH_ORDER,
      });
    });
    return toPaymentRecord(attempt);
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

  /** Marks a still-pending attempt as superseded by a retry. Its reference stays matchable for a late success. */
  async markAbandoned(id: string): Promise<void> {
    await this.prisma.paymentAttempt.updateMany({
      where: { id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.ABANDONED },
    });
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
