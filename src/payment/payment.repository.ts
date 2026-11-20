import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CashCollection,
  Order,
  OrderStatus,
  PaymentAttempt,
  PaymentIntentStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersRepository } from '../order/order.repository';
import { StoreRepository } from '../store/store.repository';
import { OutboxService } from '../outbox/outbox.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import {
  AttemptState,
  autoRefundKey,
  fromSubunits,
  ProviderVerification,
  VerificationOutcome,
} from './payment-verification';
import { LedgerAttempt } from './payment-reconciliation';

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

export interface SettledAttempt {
  outcome: VerificationOutcome;
  attempt: PaymentRecord;
  refundId?: string;
}

export type OpenedAttempt =
  | { created: true; attempt: PaymentRecord }
  | { created: false; attempt: PaymentRecord; authorizationUrl: string | null };

const PAYABLE_ORDER = {
  user: { select: { email: true } },
  paymentIntent: { select: { status: true, attempts: { select: { status: true } } } },
} as const;

export type OrderForPayment = Prisma.OrderGetPayload<{ include: typeof PAYABLE_ORDER }>;

const COLLECTABLE_ORDER = {
  paymentIntent: { select: { status: true, attempts: { select: { status: true } } } },
} as const;

export type OrderForCollection = Prisma.OrderGetPayload<{ include: typeof COLLECTABLE_ORDER }>;

export interface RecordedCollection {
  attempt: PaymentRecord;
  collection: CashCollection;
  from: OrderStatus;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersRepository: OrdersRepository,
    private readonly storeRepository: StoreRepository,
    private readonly outbox: OutboxService,
    private readonly stockLedger: StockLedgerService,
  ) {}

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

      const currency = await this.storeRepository.findCurrency(tx);
      const intent = await tx.paymentIntent.upsert({
        where: { orderId: request.orderId },
        create: { orderId: request.orderId, amount: order.grandTotal, currency },
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

  /**
   * Records the order total as cash collected and moves the order to DELIVERED, in one transaction: the intent is
   * marked PAID, a COMPLETED cash-on-delivery attempt and its cash collection are created, and `onRecorded` runs on
   * the same transaction (for the audit row). `assertCollectable` re-checks the order under its row lock and throws
   * to refuse, so a repeated call finds the order already DELIVERED and writes nothing.
   */
  async recordCashCollection(
    orderId: string,
    recordedById: string,
    assertCollectable: (order: OrderForCollection | null) => asserts order is OrderForCollection,
    onRecorded: (tx: Prisma.TransactionClient, recorded: RecordedCollection) => Promise<void>,
  ): Promise<RecordedCollection> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: COLLECTABLE_ORDER });
      assertCollectable(order);

      const amount = order.grandTotal;
      const currency = await this.storeRepository.findCurrency(tx);
      const intent = await tx.paymentIntent.upsert({
        where: { orderId },
        create: { orderId, amount, currency, status: PaymentIntentStatus.PAID },
        update: { status: PaymentIntentStatus.PAID },
      });
      const attempt = await tx.paymentAttempt.create({
        data: {
          intentId: intent.id,
          provider: PaymentProvider.CASH_ON_DELIVERY,
          amount,
          currency,
          channel: PaymentProvider.CASH_ON_DELIVERY,
          status: PaymentStatus.COMPLETED,
        },
      });
      const collection = await tx.cashCollection.create({
        data: { orderId, attemptId: attempt.id, amount, currency, recordedById },
      });
      const delivered = await this.ordersRepository.transitionStatus(tx, orderId, OrderStatus.DELIVERED, [
        order.status,
      ]);
      if (!delivered) throw new ConflictException(`Order "${orderId}" changed while its cash collection was recorded`);

      const settled = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id }, include: WITH_ORDER });
      const recorded = { attempt: toPaymentRecord(settled), collection, from: order.status };
      await onRecorded(tx, recorded);
      return recorded;
    });
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

  /** Open Paystack attempts created in [`createdFrom`, `createdBefore`), newest first: the ones a webhook may have missed. */
  async findOpenPaystackReferences(createdFrom: Date, createdBefore: Date, limit: number): Promise<string[]> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        provider: PaymentProvider.PAYSTACK,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.ABANDONED] },
        reference: { not: null },
        deleted: false,
        createdAt: { gte: createdFrom, lt: createdBefore },
      },
      select: { reference: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return attempts.map((attempt) => attempt.reference as string);
  }

  async findLedgerAttempts(references: string[]): Promise<LedgerAttempt[]> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { reference: { in: references } },
      select: { reference: true, status: true, amount: true, currency: true, reviewReason: true },
    });
    return attempts.map((attempt) => ({ ...attempt, reference: attempt.reference as string }));
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

  /**
   * Applies a provider verdict to an attempt exactly once. The order row lock serialises this with initiation,
   * cancellation and any other verification of the same order; `decide` sees the locked state. An attempt that is
   * no longer open is returned unchanged, so replays have no side effects.
   */
  async settleAttempt(
    attemptId: string,
    verified: ProviderVerification,
    providerDetails: Prisma.InputJsonValue,
    decide: (state: AttemptState) => VerificationOutcome,
  ): Promise<SettledAttempt> {
    return this.prisma.$transaction(async (tx) => {
      const { intent } = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        select: { intent: { select: { orderId: true } } },
      });
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${intent.orderId} FOR UPDATE`;
      const attempt = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        include: { intent: { include: { order: true } } },
      });
      const outcome = decide({
        status: attempt.status,
        amount: attempt.amount,
        currency: attempt.currency,
        intentStatus: attempt.intent.status,
        order: attempt.intent.order,
      });

      if (outcome.kind === 'settled') return { outcome, attempt: toPaymentRecord(attempt) };
      if (outcome.kind === 'unresolved') {
        // Order expiry reads an attempt's updatedAt as customer activity, so a repeat poll must not touch the row.
        if (attempt.rawStatus === verified.status) return { outcome, attempt: toPaymentRecord(attempt) };
        const updated = await tx.paymentAttempt.update({
          where: { id: attemptId },
          data: { rawStatus: verified.status },
          include: WITH_ORDER,
        });
        return { outcome, attempt: toPaymentRecord(updated) };
      }

      const status =
        outcome.kind === 'paid'
          ? PaymentStatus.COMPLETED
          : outcome.kind === 'failed'
            ? PaymentStatus.FAILED
            : outcome.attemptStatus;
      const { count } = await tx.paymentAttempt.updateMany({
        where: { id: attemptId, status: { in: [PaymentStatus.PENDING, PaymentStatus.ABANDONED] } },
        data: {
          status,
          rawStatus: verified.status,
          providerDetails,
          ...(outcome.kind === 'review' && { reviewReason: outcome.reason }),
        },
      });
      if (count === 0) throw new ConflictException(`Payment attempt "${attemptId}" was settled by another request`);

      let refundId: string | undefined;
      if (outcome.kind === 'paid') {
        await tx.paymentIntent.update({ where: { id: attempt.intentId }, data: { status: PaymentIntentStatus.PAID } });
        const moved = await this.ordersRepository.transitionStatus(tx, intent.orderId, OrderStatus.PROCESSING, [
          OrderStatus.PENDING,
        ]);
        if (!moved) throw new ConflictException(`Order "${intent.orderId}" left PENDING while its payment settled`);
        // The captured payment is the sale. A payment for an order that already expired (its stock released) never
        // gets here: decideVerification flags it ORDER_NOT_PAYABLE for review and refund, so nothing is oversold.
        await this.stockLedger.consumeOrder(tx, intent.orderId);
        // Recorded only on this PENDING -> PROCESSING transition, so repeat webhooks and re-verifies email nobody.
        await this.outbox.record(tx, {
          type: 'payment.succeeded.v1',
          aggregateId: intent.orderId,
          payload: { orderId: intent.orderId, paymentId: attemptId, amount: attempt.amount.toFixed(2) },
        });
      } else if (outcome.kind === 'review') {
        const refund = await tx.refund.create({
          data: {
            attemptId,
            amount: fromSubunits(verified.amount),
            currency: verified.currency,
            idempotencyKey: autoRefundKey(attemptId),
          },
        });
        refundId = refund.id;
      }

      const settled = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: WITH_ORDER });
      return { outcome, attempt: toPaymentRecord(settled), refundId };
    });
  }
}
