import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Refund, RefundStatus, ReturnRequest, ReturnStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RefundLedger } from './refund-cap';
import { OrderTaxSnapshot, refundTax } from './refund-tax';

type Tx = Prisma.TransactionClient;

/** Refunds that may be (re)sent: never sent, or refused by the provider. */
const SENDABLE_REFUND_STATUSES: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.FAILED];

export function returnRefundKey(returnRequestId: string): string {
  return `return:${returnRequestId}`;
}

export interface ClaimedRefund {
  refund: Refund;
  ledger: RefundLedger;
}

export interface RecordedRefund {
  refund: Refund;
  returnRequest: ReturnRequest | null;
}

@Injectable()
export class RefundRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByReturnRequest(returnRequestId: string): Promise<Refund | null> {
    return this.prisma.refund.findUnique({ where: { returnRequestId } });
  }

  async findAll(status?: RefundStatus): Promise<Refund[]> {
    return this.prisma.refund.findMany({ where: { status }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Moves an APPROVED return to REFUND_PENDING and records its PENDING refund in one transaction. A return that is
   * no longer APPROVED was claimed by another request, so this throws CONFLICT and writes nothing. `check` sees the
   * payment's refunds under the attempt row lock and throws to refuse.
   */
  async openForReturn(
    returnRequest: ReturnRequest & { refundAmount: Prisma.Decimal },
    attemptId: string,
    check: (ledger: RefundLedger) => void,
    onOpened: (tx: Tx, refund: Refund) => Promise<void>,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({
        where: { id: returnRequest.id, status: ReturnStatus.APPROVED },
        data: { status: ReturnStatus.REFUND_PENDING },
      });
      if (count === 0) {
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
        },
      });
      await onOpened(tx, refund);
      return refund;
    });
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

  /** Records the provider's acceptance of a SENDING refund and completes its return request, if any. */
  async recordProcessed(
    refundId: string,
    providerRef: string,
    onRecorded: (tx: Tx, recorded: RecordedRefund) => Promise<void>,
  ): Promise<RecordedRefund> {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.finishSending(tx, refundId, { status: RefundStatus.PROCESSED, providerRef });
      let returnRequest: ReturnRequest | null = null;
      if (refund.returnRequestId) {
        const { count } = await tx.returnRequest.updateMany({
          where: { id: refund.returnRequestId, status: ReturnStatus.REFUND_PENDING },
          data: { status: ReturnStatus.REFUNDED },
        });
        if (count === 0) {
          throw new ConflictException(
            `Return request "${refund.returnRequestId}" left REFUND_PENDING during its refund`,
          );
        }
        returnRequest = await tx.returnRequest.findUniqueOrThrow({ where: { id: refund.returnRequestId } });
      }
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
