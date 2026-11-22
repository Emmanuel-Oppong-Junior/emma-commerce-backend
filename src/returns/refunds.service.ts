import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  Refund,
  RefundLine,
  RefundMethod,
  RefundReason,
  RefundStatus,
  ReturnRequest,
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { assertRefundable, assertWithinCaptured } from './refund-cap';
import { PaymentProviderRegistry } from '../payment/providers/payment-provider.registry';
import { ProviderRequestRejected } from '../payment/providers/payment-provider.port';
import { RecordedRefund, RefundRepository, RefundWithOrderLines, staffRefundKey } from './refund.repository';
import { staffRefundNote } from './refund-reason';

export interface RefundOrderParams {
  orderId: string;
  idempotencyKey: string;
  lines: { orderItemId: string; quantity: number }[];
  shipping: boolean;
  amount: Prisma.Decimal | null;
  reason: RefundReason;
  note?: string | null;
}
import { DisputesService } from '../payment/disputes/disputes.service';

/**
 * Sends refunds through the attempt's payment provider. A refund is claimed (PENDING/FAILED -> SENDING) in a committed
 * transaction before the provider is called, so a repeated or concurrent request finds it SENDING and never calls the
 * provider again.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly refundRepository: RefundRepository,
    private readonly providers: PaymentProviderRegistry,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
    private readonly disputes: DisputesService,
  ) {}

  async findAll(status?: RefundStatus): Promise<Refund[]> {
    return this.refundRepository.findAll(status);
  }

  async findLines(refundId: string): Promise<RefundLine[]> {
    return this.refundRepository.findLines(refundId);
  }

  async findForOrder(orderId: string): Promise<RefundWithOrderLines[]> {
    return this.refundRepository.findForOrder(orderId);
  }

  /**
   * Refunds a paid order outside the returns flow: chosen line units, the shipping fee and/or a free amount, priced
   * from what the order stored (planRefund). Money only: nothing is restocked. A repeated idempotency key returns the
   * refund it recorded without sending anything (a PENDING one left by a crash is sent with processPendingRefund).
   * Online payments go back through their provider at once; a cash-on-delivery payment is recorded as cash handed
   * back by staff.
   */
  async refundOrder(params: RefundOrderParams, adminUserId: string): Promise<Refund> {
    const note = staffRefundNote(params.reason, params.note);
    const { refund, replayed } = await this.refundRepository.openForOrder(
      {
        orderId: params.orderId,
        idempotencyKey: staffRefundKey(params.idempotencyKey),
        reason: params.reason,
        note,
        createdById: adminUserId,
        parts: { lines: params.lines, shipping: params.shipping, amount: params.amount },
      },
      (ledger, plan, method) =>
        method === RefundMethod.CASH
          ? assertWithinCaptured(ledger, { amount: plan.amount })
          : assertRefundable(ledger, { amount: plan.amount }),
      (tx, opened) =>
        this.auditService.log(
          {
            entity: 'Refund',
            entityId: opened.id,
            action: opened.method === RefundMethod.CASH ? 'REFUND' : 'CREATE',
            userId: adminUserId,
            details: {
              orderId: params.orderId,
              attemptId: opened.attemptId,
              status: opened.status,
              method: opened.method,
              reason: opened.reason,
              amount: String(opened.amount),
              shippingAmount: String(opened.shippingAmount),
              currency: opened.currency,
              lines: params.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
            },
          },
          tx,
        ),
    );
    if (replayed || refund.method === RefundMethod.CASH) return refund;
    const { refund: sent } = await this.send(refund.id, adminUserId);
    return sent;
  }

  /** Sends a PENDING refund (such as an auto-refund queued by payment verification) or resends a FAILED one. */
  async processPendingRefund(refundId: string, adminUserId: string): Promise<Refund> {
    const { refund } = await this.send(refundId, adminUserId);
    return refund;
  }

  /** Opens the refund for an APPROVED return request: the return moves to REFUND_PENDING and a PENDING refund is recorded. */
  async openForReturn(
    returnRequest: ReturnRequest & { refundAmount: Prisma.Decimal },
    attemptId: string,
    adminUserId: string,
  ): Promise<Refund> {
    return this.refundRepository.openForReturn(
      returnRequest,
      attemptId,
      (ledger) => assertRefundable(ledger, { amount: returnRequest.refundAmount }),
      (tx, refund) =>
        this.auditService.log(
          {
            entity: 'ReturnRequest',
            entityId: returnRequest.id,
            action: 'STATUS_CHANGE',
            userId: adminUserId,
            details: {
              orderId: returnRequest.orderId,
              from: returnRequest.status,
              to: 'REFUND_PENDING',
              refundId: refund.id,
              amount: String(refund.amount),
            },
          },
          tx,
        ),
    );
  }

  /**
   * Claims the refund, calls the provider once and records the outcome. A refusal (4xx) marks it FAILED so it can be
   * sent again. Any other failure (timeout, 5xx, unreadable answer) leaves it SENDING: the provider may have created
   * the refund, so it must be checked there before anyone sends money again.
   */
  async send(refundId: string, adminUserId: string): Promise<RecordedRefund> {
    await this.disputes.assertRefundAllowed(refundId);
    const { refund, ledger } = await this.refundRepository.claimForSending(
      refundId,
      (locked, claimed) => assertRefundable(locked, claimed),
      (tx, claimed) =>
        this.auditService.log(
          {
            entity: 'Refund',
            entityId: claimed.id,
            action: 'STATUS_CHANGE',
            userId: adminUserId,
            details: {
              from: claimed.status,
              to: RefundStatus.SENDING,
              attemptId: claimed.attemptId,
              returnRequestId: claimed.returnRequestId,
              amount: String(claimed.amount),
              currency: claimed.currency,
            },
          },
          tx,
        ),
    );
    const reference = ledger.attempt.reference as string;
    const provider = this.providers.get(ledger.attempt.provider);

    let providerRefundId: string;
    try {
      providerRefundId = await provider.refund({ reference, amount: refund.amount });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderRequestRejected) {
        this.logger.warn(
          `${provider.label} refused refund; marked FAILED, it can be sent again | refundId: ${refund.id} | reference: ${reference}`,
          'RefundsService',
        );
        await this.recordRejected(refund, reason, adminUserId);
        throw new BadRequestException(
          `${provider.label} refused refund "${refund.id}": ${reason}. Nothing was refunded; it can be sent again.`,
        );
      }
      this.logger.error(
        `${provider.label} refund outcome unknown; left SENDING, check ${provider.label} before resending | refundId: ${refund.id} | reference: ${reference}`,
        reason,
        'RefundsService',
      );
      await this.refundRepository.noteUnknownOutcome(refund.id, `Outcome unknown: ${reason}`);
      throw error;
    }

    this.logger.log(
      `${provider.label} refund accepted | refundId: ${refund.id} | providerRefundId: ${providerRefundId} | reference: ${reference}`,
      'RefundsService',
    );
    return this.refundRepository.recordProcessed(refund.id, providerRefundId, async (tx, recorded) => {
      const amount = String(recorded.refund.amount);
      await this.auditService.log(
        {
          entity: 'Refund',
          entityId: recorded.refund.id,
          action: 'REFUND',
          userId: adminUserId,
          details: {
            from: RefundStatus.SENDING,
            to: RefundStatus.PROCESSED,
            amount,
            currency: recorded.refund.currency,
            providerReference: reference,
            providerRefundId,
          },
        },
        tx,
      );
      if (recorded.returnRequest) {
        await this.auditService.log(
          {
            entity: 'ReturnRequest',
            entityId: recorded.returnRequest.id,
            action: 'REFUND',
            userId: adminUserId,
            details: {
              orderId: recorded.returnRequest.orderId,
              from: 'REFUND_PENDING',
              to: 'REFUNDED',
              amount,
              providerReference: reference,
              providerRefundId,
            },
          },
          tx,
        );
      }
    });
  }

  private async recordRejected(refund: Refund, reason: string, adminUserId: string): Promise<void> {
    await this.refundRepository.recordRejected(refund.id, reason, (tx, failed) =>
      this.auditService.log(
        {
          entity: 'Refund',
          entityId: failed.id,
          action: 'STATUS_CHANGE',
          userId: adminUserId,
          details: { from: RefundStatus.SENDING, to: RefundStatus.FAILED, reason },
        },
        tx,
      ),
    );
  }
}
