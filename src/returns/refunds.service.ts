import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, Refund, RefundStatus, ReturnRequest } from '@prisma/client';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { PaystackClient, PaystackRequestRejected } from '../payment/paystack.client';
import { assertRefundable } from './refund-cap';
import { RecordedRefund, RefundRepository } from './refund.repository';

/**
 * Sends refunds through Paystack. A refund is claimed (PENDING/FAILED -> SENDING) in a committed transaction before
 * the provider is called, so a repeated or concurrent request finds it SENDING and never calls Paystack again.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly refundRepository: RefundRepository,
    private readonly paystack: PaystackClient,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
  ) {}

  async findAll(status?: RefundStatus): Promise<Refund[]> {
    return this.refundRepository.findAll(status);
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
   * Claims the refund, calls Paystack once and records the outcome. A refusal (4xx) marks it FAILED so it can be sent
   * again. Any other failure (timeout, 5xx, unreadable answer) leaves it SENDING: Paystack may have created the
   * refund, so it must be checked there before anyone sends money again.
   */
  async send(refundId: string, adminUserId: string): Promise<RecordedRefund> {
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

    let providerRefundId: string;
    try {
      ({ id: providerRefundId } = await this.paystack.createRefund({
        transaction: reference,
        amount: refund.amount.mul(100).toNumber(),
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof PaystackRequestRejected) {
        await this.recordRejected(refund, reason, adminUserId);
        throw new BadRequestException(
          `Paystack refused refund "${refund.id}": ${reason}. Nothing was refunded; it can be sent again.`,
        );
      }
      this.logger.error(
        `Paystack refund outcome unknown; left SENDING, check Paystack before resending | refundId: ${refund.id} | reference: ${reference}`,
        reason,
        'RefundsService',
      );
      await this.refundRepository.noteUnknownOutcome(refund.id, `Outcome unknown: ${reason}`);
      throw error;
    }

    this.logger.log(
      `Paystack refund accepted | refundId: ${refund.id} | providerRefundId: ${providerRefundId} | reference: ${reference}`,
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
