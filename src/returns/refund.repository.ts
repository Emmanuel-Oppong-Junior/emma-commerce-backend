import { LoyaltyLedger } from '../loyalty/loyalty-ledger.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  Refund,
  RefundLine,
  RefundMethod,
  RefundReason,
  RefundStatus,
  ReturnRequest,
  ReturnStatus,
} from '../generated/prisma/client';
import { autoRefundKey } from '../payment/payment-verification';
import { intentAllowedFrom, statusAfterRefunds } from '../payment/payment-intent-status';
import { transitionOrder } from '../order/order-transition';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { RefundLedger, refundableAmount } from './refund-cap';
import { planRefund, RefundableOrder, RefundPlan, RefundRequestParts } from './refund-plan';
import { OrderTaxSnapshot, refundTax } from './refund-tax';
import { transitionReturn } from './return-transition';
import { returnRefundParts } from './return-rules';

type Tx = Prisma.TransactionClient;

/** Refunds that may be (re)sent: never sent, or refused by the provider. */
const SENDABLE_REFUND_STATUSES: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.FAILED];

export function returnRefundKey(returnRequestId: string): string {
  return `return:${returnRequestId}`;
}

/** The refund a paid order's cancellation records, at most one per order. */
export function cancellationRefundKey(orderId: string): string {
  return `cancel:${orderId}`;
}

/** Staff keys live in their own namespace, so they can never collide with the system's return or auto-refund keys. */
export function staffRefundKey(idempotencyKey: string): string {
  return `staff:${idempotencyKey}`;
}

export interface ClaimedRefund {
  refund: Refund;
  ledger: RefundLedger;
}

export interface RecordedRefund {
  refund: Refund;
  returnRequest: ReturnRequest | null;
}

export interface StaffRefundRequest {
  orderId: string;
  /** Already namespaced with staffRefundKey. */
  idempotencyKey: string;
  reason: RefundReason;
  note: string | null;
  createdById: string;
  parts: RefundRequestParts;
}

export interface OpenedRefund {
  refund: Refund;
  /** True when the idempotency key had already recorded this refund: nothing new was written. */
  replayed: boolean;
}

export type RefundWithOrderLines = Refund & {
  lines: (RefundLine & { orderItem: { productName: string } })[];
};

@Injectable()
export class RefundRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly loyalty: LoyaltyLedger,
  ) {}

  async findByReturnRequest(returnRequestId: string): Promise<Refund | null> {
    return this.prisma.refund.findUnique({ where: { returnRequestId } });
  }

  async findAll(status?: RefundStatus): Promise<Refund[]> {
    return this.prisma.refund.findMany({ where: { status }, orderBy: { createdAt: 'desc' } });
  }

  async findLines(refundId: string): Promise<RefundLine[]> {
    return this.prisma.refundLine.findMany({ where: { refundId }, orderBy: { id: 'asc' } });
  }

  /** Every refund of the order's payments, oldest first, with the product name of each refunded line. */
  async findForOrder(orderId: string): Promise<RefundWithOrderLines[]> {
    return this.prisma.refund.findMany({
      where: { attempt: { intent: { orderId } } },
      include: { lines: { include: { orderItem: { select: { productName: true } } }, orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Records a staff refund of a paid order in one transaction, under the row lock of the attempt that paid it, so
   * concurrent refunds of one order are serialised and the caps cannot race. A key that already recorded a refund
   * returns that refund and writes nothing. The amount comes from planRefund over what the order stored; `check` sees
   * the payment's refunds and throws to refuse. Cash-on-delivery payments have no provider to send through: the refund
   * is recorded as handed back in cash (PROCESSED) and the payment machine follows at once.
   */
  async openForOrder(
    request: StaffRefundRequest,
    check: (ledger: RefundLedger, plan: RefundPlan, method: RefundMethod) => void,
    onOpened: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<OpenedRefund> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: request.orderId }, select: { deleted: true } });
      if (!order || order.deleted) throw new NotFoundException(`Order "${request.orderId}" not found`);
      const payment = await tx.paymentAttempt.findFirst({
        where: { intent: { orderId: request.orderId }, status: PaymentStatus.CAPTURED, reviewReason: null },
        select: { id: true },
      });
      if (!payment) throw new BadRequestException(`Order "${request.orderId}" has no captured payment to refund`);
      const ledger = await this.lockLedger(tx, payment.id);

      const existing = await tx.refund.findUnique({ where: { idempotencyKey: request.idempotencyKey } });
      if (existing) {
        if (existing.attemptId !== payment.id) {
          throw new ConflictException('This idempotency key was already used for a refund of another order');
        }
        return { refund: existing, replayed: true };
      }

      const plan = planRefund(await this.refundableOrder(tx, request.orderId, ledger), request.parts);
      const method =
        ledger.attempt.provider === PaymentProvider.CASH_ON_DELIVERY ? RefundMethod.CASH : RefundMethod.PROVIDER;
      check(ledger, plan, method);
      const refund = await tx.refund.create({
        data: {
          attemptId: payment.id,
          amount: plan.amount,
          taxAmount: plan.taxAmount,
          shippingAmount: plan.shippingAmount,
          currency: ledger.attempt.currency,
          idempotencyKey: request.idempotencyKey,
          reason: request.reason,
          note: request.note,
          method,
          createdById: request.createdById,
          status: method === RefundMethod.CASH ? RefundStatus.PROCESSED : RefundStatus.PENDING,
          lines: { create: plan.lines },
        },
      });
      if (method === RefundMethod.CASH) await this.followProcessed(tx, refund);
      await onOpened(tx, refund);
      return { refund, replayed: false };
    });
  }

  /**
   * Moves an APPROVED return to REFUND_PENDING and records its PENDING refund in one transaction. A return that is
   * no longer APPROVED was claimed by another request, so this throws CONFLICT and writes nothing. `check` sees the
   * payment's refunds under the attempt row lock and throws to refuse.
   */
  async openForReturn(
    returnRequest: ReturnRequest & { refundAmount: Prisma.Decimal },
    attemptId: string,
    actorId: string,
    check: (ledger: RefundLedger) => void,
    onOpened: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const left = await transitionReturn(tx, returnRequest.id, ReturnStatus.REFUND_PENDING, [ReturnStatus.APPROVED], {
        actorId,
      });
      if (!left) {
        throw new ConflictException(`Return request "${returnRequest.id}" is no longer APPROVED`);
      }
      const ledger = await this.lockLedger(tx, attemptId);
      check(ledger);
      const taxAmount = refundTax(returnRequest.refundAmount, await this.orderTax(tx, returnRequest.orderId));
      const refund = await tx.refund.create({
        data: {
          attemptId,
          returnRequestId: returnRequest.id,
          amount: returnRequest.refundAmount,
          taxAmount,
          currency: ledger.attempt.currency,
          idempotencyKey: returnRefundKey(returnRequest.id),
          reason: RefundReason.RETURN,
        },
      });
      await onOpened(tx, refund);
      return refund;
    });
  }

  /**
   * Records the refund of an INSPECTED item-level return in one transaction: the return is claimed first (conditional
   * move with its history event: REFUND_PENDING, or REFUNDED at once for a cash-on-delivery payment, whose refund is
   * cash handed back), then, under the paying attempt's row lock, the units received on each line (and the delivery fee
   * when `shipping`) are priced from the order's stored snapshot (planRefund) into a refund with one RefundLine per
   * line. A return no longer INSPECTED was claimed by another request: CONFLICT, nothing written. `check` sees the
   * payment's refunds and the plan and throws to refuse.
   */
  async openForReturnLines(
    request: { returnRequestId: string; shipping: boolean; actorId: string; note: string | null },
    check: (ledger: RefundLedger, plan: RefundPlan, method: RefundMethod) => void,
    onOpened: (tx: Tx, refund: Refund, returnRequest: ReturnRequest) => Promise<void>,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const returnRequest = await tx.returnRequest.findUnique({
        where: { id: request.returnRequestId },
        include: { lines: { select: { orderItemId: true, receivedQuantity: true }, orderBy: { id: 'asc' } } },
      });
      if (!returnRequest) throw new NotFoundException(`Return request "${request.returnRequestId}" not found`);
      const payment = await tx.paymentAttempt.findFirst({
        where: { intent: { orderId: returnRequest.orderId }, status: PaymentStatus.CAPTURED, reviewReason: null },
        select: { id: true, provider: true },
      });
      if (!payment) {
        throw new BadRequestException(`Order "${returnRequest.orderId}" has no captured payment to refund`);
      }
      const method = payment.provider === PaymentProvider.CASH_ON_DELIVERY ? RefundMethod.CASH : RefundMethod.PROVIDER;
      const left = await transitionReturn(
        tx,
        returnRequest.id,
        method === RefundMethod.CASH ? ReturnStatus.REFUNDED : ReturnStatus.REFUND_PENDING,
        [ReturnStatus.INSPECTED],
        { actorId: request.actorId, note: request.note },
      );
      if (!left) throw new ConflictException(`Return request "${returnRequest.id}" is no longer INSPECTED`);
      const ledger = await this.lockLedger(tx, payment.id);
      const plan = planRefund(
        await this.refundableOrder(tx, returnRequest.orderId, ledger),
        returnRefundParts(returnRequest.lines, request.shipping),
      );
      check(ledger, plan, method);
      const refund = await tx.refund.create({
        data: {
          attemptId: payment.id,
          returnRequestId: returnRequest.id,
          amount: plan.amount,
          taxAmount: plan.taxAmount,
          shippingAmount: plan.shippingAmount,
          currency: ledger.attempt.currency,
          idempotencyKey: returnRefundKey(returnRequest.id),
          reason: RefundReason.RETURN,
          method,
          createdById: request.actorId,
          status: method === RefundMethod.CASH ? RefundStatus.PROCESSED : RefundStatus.PENDING,
          lines: { create: plan.lines },
        },
      });
      if (method === RefundMethod.CASH) await this.followProcessed(tx, refund);
      await onOpened(tx, refund, returnRequest);
      return refund;
    });
  }

  /**
   * Records, on the cancel transaction of a paid online order, a PENDING refund of everything still refundable on its
   * payment (reason ORDER_CANCELLED), for staff to send with processPendingRefund. Nothing when the order has no
   * accepted capture, nothing is left to refund, or its cancellation refund already exists.
   */
  async openForCancelledOrder(
    tx: Tx,
    orderId: string,
    onOpened: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<Refund | null> {
    const payment = await tx.paymentAttempt.findFirst({
      where: { intent: { orderId }, status: PaymentStatus.CAPTURED, reviewReason: null },
      select: { id: true },
    });
    if (!payment) return null;
    const ledger = await this.lockLedger(tx, payment.id);
    if (ledger.refunds.some((refund) => refund.idempotencyKey === cancellationRefundKey(orderId))) return null;
    const refundable = refundableAmount(ledger);
    if (refundable.lte(0)) return null;
    const plan = planRefund(await this.refundableOrder(tx, orderId, ledger), {
      lines: [],
      shipping: false,
      amount: refundable,
    });
    const refund = await tx.refund.create({
      data: {
        attemptId: payment.id,
        amount: plan.amount,
        taxAmount: plan.taxAmount,
        currency: ledger.attempt.currency,
        idempotencyKey: cancellationRefundKey(orderId),
        reason: RefundReason.ORDER_CANCELLED,
      },
    });
    await onOpened(tx, refund);
    return refund;
  }

  /**
   * Claims a PENDING or FAILED refund for sending (status SENDING). Only one request can win the claim; the others
   * get CONFLICT, so the provider is called at most once per claim. `check` re-checks the cap under the lock.
   */
  async claimForSending(
    refundId: string,
    check: (ledger: RefundLedger, refund: Refund) => void,
    onClaimed: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<ClaimedRefund> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.refund.findUnique({ where: { id: refundId }, select: { attemptId: true } });
      if (!found) throw new NotFoundException(`Refund "${refundId}" not found`);
      const ledger = await this.lockLedger(tx, found.attemptId);
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (!SENDABLE_REFUND_STATUSES.includes(refund.status)) {
        throw new ConflictException(`Refund "${refundId}" is ${refund.status} and cannot be sent again`);
      }
      check(ledger, refund);
      const { count } = await tx.refund.updateMany({
        where: { id: refundId, status: { in: SENDABLE_REFUND_STATUSES } },
        data: { status: RefundStatus.SENDING, failureReason: null },
      });
      if (count === 0) throw new ConflictException(`Refund "${refundId}" was claimed by another request`);
      await onClaimed(tx, refund);
      return { refund, ledger };
    });
  }

  /**
   * Records the provider's acceptance of a SENDING refund and completes its return request, if any. In the same
   * transaction the payment machine follows: a refund of the order's accepted capture moves its intent to
   * PARTIALLY_REFUNDED or REFUNDED, and once every auto-refund of a late payment is processed an order in
   * PAYMENT_REVIEW is CANCELLED.
   */
  async recordProcessed(
    refundId: string,
    providerRef: string,
    actorId: string,
    onRecorded: (tx: Tx, recorded: RecordedRefund) => Promise<void>,
  ): Promise<RecordedRefund> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.finishSending(tx, refundId, { status: RefundStatus.PROCESSED, providerRef });
      let returnRequest: ReturnRequest | null = null;
      if (refund.returnRequestId) {
        const left = await transitionReturn(
          tx,
          refund.returnRequestId,
          ReturnStatus.REFUNDED,
          [ReturnStatus.REFUND_PENDING],
          { actorId },
        );
        if (!left) {
          throw new ConflictException(
            `Return request "${refund.returnRequestId}" left REFUND_PENDING during its refund`,
          );
        }
        returnRequest = await tx.returnRequest.findUniqueOrThrow({ where: { id: refund.returnRequestId } });
      }
      await this.followProcessed(tx, refund);
      const recorded = { refund, returnRequest };
      await onRecorded(tx, recorded);
      return recorded;
    });
  }

  /** Records that the provider refused a SENDING refund, so nothing moved and it may be sent again. */
  async recordRejected(
    refundId: string,
    failureReason: string,
    onRecorded: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.finishSending(tx, refundId, { status: RefundStatus.FAILED, failureReason });
      await onRecorded(tx, refund);
      return refund;
    });
  }

  /** Notes why a SENDING refund's outcome is unknown. It stays SENDING, so nobody can send it again blindly. */
  async noteUnknownOutcome(refundId: string, failureReason: string): Promise<void> {
    await this.prisma.refund.updateMany({
      where: { id: refundId, status: RefundStatus.SENDING },
      data: { failureReason },
    });
  }

  private async finishSending(tx: Tx, refundId: string, data: Prisma.RefundUpdateManyMutationInput): Promise<Refund> {
    const { count } = await tx.refund.updateMany({ where: { id: refundId, status: RefundStatus.SENDING }, data });
    if (count === 0) throw new ConflictException(`Refund "${refundId}" is no longer SENDING`);
    return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /**
   * A refund has moved money: the payment machine follows, the order's loyalty points follow the goods refunded, and
   * the customer is told (by the worker, via the outbox).
   */
  private async followProcessed(tx: Tx, refund: Refund): Promise<void> {
    const orderId = await this.followRefund(tx, refund);
    await this.loyalty.settleOrder(tx, orderId, new Date());
    await this.outbox.record(tx, {
      type: 'refund.succeeded.v1',
      aggregateId: orderId,
      payload: { orderId, refundId: refund.id },
    });
  }

  /** Moves the payment machine after a processed refund and returns the order's id. */
  private async followRefund(tx: Tx, refund: Refund): Promise<string> {
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({
      where: { id: refund.attemptId },
      select: {
        id: true,
        status: true,
        amount: true,
        reviewReason: true,
        intentId: true,
        intent: { select: { orderId: true } },
        refunds: { select: { amount: true, status: true, idempotencyKey: true } },
      },
    });
    if (attempt.status === PaymentStatus.CAPTURED && attempt.reviewReason === null) {
      const refunded = attempt.refunds
        .filter((other) => other.status === RefundStatus.PROCESSED)
        .reduce((total, other) => total.add(other.amount), new Prisma.Decimal(0));
      const to = statusAfterRefunds(attempt.amount, refunded);
      await tx.paymentIntent.updateMany({
        where: { id: attempt.intentId, status: { in: intentAllowedFrom(to) } },
        data: { status: to },
      });
    }
    const { orderId } = attempt.intent;
    if (refund.idempotencyKey !== autoRefundKey(attempt.id)) return orderId;
    const unrefunded = await tx.refund.count({
      where: {
        attempt: { intent: { orderId } },
        idempotencyKey: { startsWith: 'auto-refund:' },
        status: { not: RefundStatus.PROCESSED },
      },
    });
    if (unrefunded > 0) return orderId;
    await transitionOrder(tx, orderId, OrderStatus.CANCELLED, [OrderStatus.PAYMENT_REVIEW], {
      reason: 'Payment received after the order closed was refunded',
    });
    return orderId;
  }

  /** What the order stored at placement and what its refunds (FAILED excluded) have already taken. */
  private async refundableOrder(tx: Tx, orderId: string, ledger: RefundLedger): Promise<RefundableOrder> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        pricingVersion: true,
        grandTotal: true,
        shippingTotal: true,
        items: {
          select: {
            id: true,
            quantity: true,
            lineTotal: true,
            orderAdjustmentShare: true,
            taxLines: { select: { amount: true } },
          },
        },
      },
    });
    const refunds = await tx.refund.findMany({
      where: { attempt: { intent: { orderId } }, status: { not: RefundStatus.FAILED } },
      select: { taxAmount: true, shippingAmount: true, lines: { select: { orderItemId: true, quantity: true } } },
    });
    const refundedUnits = new Map<string, number>();
    for (const line of refunds.flatMap((refund) => refund.lines)) {
      refundedUnits.set(line.orderItemId, (refundedUnits.get(line.orderItemId) ?? 0) + line.quantity);
    }
    return {
      pricingVersion: order.pricingVersion,
      grandTotal: order.grandTotal,
      shippingTotal: order.shippingTotal,
      currency: ledger.attempt.currency,
      taxLineAmounts: order.items.flatMap((item) => item.taxLines.map((tax) => tax.amount)),
      refundedTax: refunds.flatMap((refund) => (refund.taxAmount === null ? [] : [refund.taxAmount])),
      shippingRefunded: refunds.some((refund) => refund.shippingAmount.gt(0)),
      lines: order.items.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        orderAdjustmentShare: item.orderAdjustmentShare,
        taxLineAmounts: item.taxLines.map((tax) => tax.amount),
        refundedQuantity: refundedUnits.get(item.id) ?? 0,
      })),
      refundable: refundableAmount(ledger),
    };
  }

  /** The order's stored tax snapshot and the tax its earlier refunds already returned. */
  private async orderTax(tx: Tx, orderId: string): Promise<OrderTaxSnapshot> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { pricingVersion: true, grandTotal: true },
    });
    const taxLines = await tx.orderLineTax.findMany({ where: { orderItem: { orderId } }, select: { amount: true } });
    const refunds = await tx.refund.findMany({
      where: { attempt: { intent: { orderId } }, status: { not: RefundStatus.FAILED }, taxAmount: { not: null } },
      select: { taxAmount: true },
    });
    return {
      ...order,
      taxLineAmounts: taxLines.map((line) => line.amount),
      refundedTax: refunds.map((refund) => refund.taxAmount as Prisma.Decimal),
    };
  }

  // The attempt row lock serialises every refund written against one payment, so the cap check cannot race.
  private async lockLedger(tx: Tx, attemptId: string): Promise<RefundLedger> {
    await tx.$queryRaw`SELECT 1 FROM "PaymentAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: {
        id: true,
        status: true,
        provider: true,
        reference: true,
        amount: true,
        currency: true,
        refunds: { select: { id: true, amount: true, status: true, idempotencyKey: true } },
      },
    });
    const { refunds, ...rest } = attempt;
    return { attempt: rest, refunds };
  }
}
