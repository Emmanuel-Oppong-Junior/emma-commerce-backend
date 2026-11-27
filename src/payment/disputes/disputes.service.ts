import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Dispute,
  DisputeSource,
  DisputeStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '../../generated/prisma/client';
import { AuditService } from '../../commons/audit.service';
import { LoggerService } from '../../commons/logger.service';
import { OutboxService } from '../../outbox/outbox.service';
import { capturedAmount, RefundLedger } from '../../returns/refund-cap';
import { DisputeNotice } from './dispute-notice';
import { assertDisputesAllowRefund } from './dispute-refund-guard';
import {
  assertDisputeTransition,
  canDisputeTransition,
  isDisputeResolved,
  UNRESOLVED_DISPUTE_STATUSES,
} from './dispute-status';
import { DisputedAttempt, DisputeFilter, DisputeRecord, DisputesRepository } from './disputes.repository';

const CONTEXT = 'Disputes';

export interface RecordDisputeParams {
  paymentId: string;
  amount: Prisma.Decimal;
  category?: string | null;
  reason?: string | null;
  providerDisputeId?: string | null;
  evidenceDueAt?: Date | null;
  status?: DisputeStatus;
}

/**
 * Chargebacks and disputes on captured payments (P3-E.2): created and moved by the provider's dispute webhooks
 * (through the webhook inbox) or by staff. Status changes follow the pure transition table in dispute-status.ts; each
 * change writes a DisputeEvent in the same transaction, and every staff change an audit row.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly repository: DisputesRepository,
    private readonly auditService: AuditService,
    private readonly outbox: OutboxService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Applies a provider dispute notice idempotently: creates the dispute on first sight (with a
   * `payment.dispute_opened.v1` event), then moves it to the notice's status when the transition table allows it. A
   * repeated or late notice (e.g. a reminder after the resolution) changes nothing. Throws NOT_FOUND when the
   * disputed reference is not one of ours, so the webhook job retries and ends in the failed-jobs list.
   */
  async applyProviderNotice(
    provider: PaymentProvider,
    notice: DisputeNotice,
    webhookEventId: string,
  ): Promise<Dispute> {
    return this.repository.runTransaction(async (tx) => {
      const attempt = await this.repository.findAttemptByReference(tx, provider, notice.reference);
      if (!attempt) {
        throw new NotFoundException(
          `Dispute "${notice.providerDisputeId}" names reference "${notice.reference}", which matches no ${provider} payment`,
        );
      }
      const providerChange = {
        source: DisputeSource.PROVIDER,
        providerStatus: notice.providerStatus,
        webhookEventId,
      };
      let dispute = await this.repository.lockByProviderId(tx, provider, notice.providerDisputeId);
      if (!dispute) {
        const initial = notice.status && UNRESOLVED_DISPUTE_STATUSES.includes(notice.status) ? notice.status : 'OPEN';
        dispute = await this.repository.create(
          tx,
          {
            attemptId: attempt.id,
            orderId: attempt.orderId,
            provider,
            providerDisputeId: notice.providerDisputeId,
            amount: new Prisma.Decimal(notice.amount),
            currency: notice.currency,
            category: notice.category,
            status: initial,
            source: DisputeSource.PROVIDER,
            evidenceDueAt: notice.evidenceDueAt ? new Date(notice.evidenceDueAt) : null,
          },
          { ...providerChange, from: null, to: initial },
        );
        await this.recordOpened(tx, dispute);
      } else if (notice.evidenceDueAt && dispute.evidenceDueAt?.toISOString() !== notice.evidenceDueAt) {
        await this.repository.update(tx, dispute.id, { evidenceDueAt: new Date(notice.evidenceDueAt) });
      }

      const target = notice.status;
      const summary = `disputeId: ${dispute.id} | provider dispute: ${notice.providerDisputeId} | stage: ${notice.stage}`;
      if (!target) {
        this.logger.warn(
          `Dispute notice with a provider status we do not map; status left at ${dispute.status}, set it by hand if needed | ${summary} | provider status: ${notice.providerStatus ?? 'none'}`,
          CONTEXT,
        );
      } else if (target !== dispute.status) {
        if (canDisputeTransition(dispute.status, target)) {
          const resolvedAt = isDisputeResolved(target)
            ? notice.resolvedAt
              ? new Date(notice.resolvedAt)
              : new Date()
            : null;
          await this.repository.transition(
            tx,
            dispute.id,
            { ...providerChange, from: dispute.status, to: target },
            resolvedAt,
          );
          this.logger.log(`Dispute moved ${dispute.status} -> ${target} | ${summary}`, CONTEXT);
        } else {
          this.logger.warn(
            `Late dispute notice ignored: ${dispute.status} -> ${target} is not allowed | ${summary}`,
            CONTEXT,
          );
        }
      }
      return dispute;
    });
  }

  /** Staff record a dispute the provider did not send (or sent elsewhere) against a captured online payment. */
  async recordDispute(params: RecordDisputeParams, actorId: string): Promise<DisputeRecord> {
    const status = params.status ?? DisputeStatus.OPEN;
    if (!UNRESOLVED_DISPUTE_STATUSES.includes(status)) {
      throw new BadRequestException(
        `A new dispute starts unresolved (OPEN, AWAITING_EVIDENCE or UNDER_REVIEW), got ${status}`,
      );
    }
    return this.auditService.record(
      async (tx) => {
        const attempt = await this.repository.findAttempt(tx, params.paymentId);
        assertDisputable(attempt, params.paymentId, params.amount);
        const dispute = await this.repository.create(
          tx,
          {
            attemptId: attempt.id,
            orderId: attempt.orderId,
            provider: attempt.provider,
            providerDisputeId: params.providerDisputeId ?? null,
            amount: params.amount,
            currency: attempt.currency,
            category: params.category ?? null,
            reason: params.reason ?? null,
            status,
            source: DisputeSource.STAFF,
            createdById: actorId,
            evidenceDueAt: params.evidenceDueAt ?? null,
          },
          { from: null, to: status, source: DisputeSource.STAFF, actorId },
        );
        await this.recordOpened(tx, dispute);
        return (await this.repository.findById(dispute.id, tx)) as DisputeRecord;
      },
      (dispute) => ({
        entity: 'Dispute',
        entityId: dispute.id,
        action: 'CREATE',
        userId: actorId,
        details: {
          paymentId: dispute.attemptId,
          orderId: dispute.orderId,
          amount: dispute.amount.toFixed(2),
          currency: dispute.currency,
          status: dispute.status,
          providerDisputeId: dispute.providerDisputeId,
        },
      }),
    );
  }

  async updateStatus(id: string, status: DisputeStatus, note: string | null, actorId: string): Promise<DisputeRecord> {
    return this.auditService
      .record(
        async (tx) => {
          const dispute = await this.repository.lockById(tx, id);
          if (!dispute) throw new NotFoundException(`Dispute "${id}" not found`);
          assertDisputeTransition(dispute.status, status);
          await this.repository.transition(
            tx,
            id,
            { from: dispute.status, to: status, source: DisputeSource.STAFF, actorId, note },
            isDisputeResolved(status) ? new Date() : null,
          );
          return { from: dispute.status, dispute: (await this.repository.findById(id, tx)) as DisputeRecord };
        },
        ({ from, dispute }) => ({
          entity: 'Dispute',
          entityId: id,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: { from, to: dispute.status, note },
        }),
      )
      .then(({ dispute }) => dispute);
  }

  /** Appends a staff evidence note; notes are never edited or deleted. */
  async addNote(id: string, body: string, actorId: string): Promise<DisputeRecord> {
    return this.auditService
      .record(
        async (tx) => {
          const dispute = await this.repository.lockById(tx, id);
          if (!dispute) throw new NotFoundException(`Dispute "${id}" not found`);
          const note = await this.repository.addNote(tx, id, actorId, body);
          return { noteId: note.id, dispute: (await this.repository.findById(id, tx)) as DisputeRecord };
        },
        ({ noteId }) => ({
          entity: 'Dispute',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: { noteAdded: noteId },
        }),
      )
      .then(({ dispute }) => dispute);
  }

  async findOne(id: string): Promise<DisputeRecord> {
    const dispute = await this.repository.findById(id);
    if (!dispute) throw new NotFoundException(`Dispute "${id}" not found`);
    return dispute;
  }

  async findMany(filter: DisputeFilter): Promise<DisputeRecord[]> {
    return this.repository.findMany(filter);
  }

  /**
   * The refund path's dispute guard: CONFLICT with reason PAYMENT_DISPUTED while the refund's payment has an
   * unresolved dispute, or when the refund would exceed what is left after a lost or accepted chargeback.
   */
  async assertRefundAllowed(refundId: string): Promise<void> {
    const found = await this.repository.findDisputedPayment(refundId);
    if (!found) throw new NotFoundException(`Refund "${refundId}" not found`);
    assertDisputesAllowRefund(found.payment, found.refund);
  }

  /**
   * The same guard for a refund about to be recorded, on the caller's transaction after it locked the payment's
   * refund ledger, so a refused refund writes nothing.
   */
  async assertNewRefundAllowed(
    tx: Prisma.TransactionClient,
    ledger: RefundLedger,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const disputes = await this.repository.findForAttempt(tx, ledger.attempt.id);
    assertDisputesAllowRefund(
      {
        attemptId: ledger.attempt.id,
        currency: ledger.attempt.currency,
        captured: capturedAmount(ledger),
        disputes,
        refunds: ledger.refunds,
      },
      { amount },
    );
  }

  private async recordOpened(tx: Prisma.TransactionClient, dispute: Dispute): Promise<void> {
    await this.outbox.record(tx, {
      type: 'payment.dispute_opened.v1',
      aggregateId: dispute.id,
      payload: {
        disputeId: dispute.id,
        paymentId: dispute.attemptId,
        orderId: dispute.orderId,
        source: dispute.source,
      },
    });
  }
}

function assertDisputable(
  attempt: DisputedAttempt | null,
  paymentId: string,
  amount: Prisma.Decimal,
): asserts attempt is DisputedAttempt {
  if (!attempt) throw new NotFoundException(`Payment "${paymentId}" not found`);
  if (attempt.provider === PaymentProvider.CASH_ON_DELIVERY) {
    throw new BadRequestException(`Payment "${paymentId}" is cash on delivery; only online payments can be disputed`);
  }
  if (attempt.status !== PaymentStatus.CAPTURED) {
    throw new ConflictException(`Payment "${paymentId}" is ${attempt.status}; only a captured payment can be disputed`);
  }
  if (amount.lte(0) || amount.gt(attempt.amount)) {
    throw new BadRequestException(
      `Dispute amount must be more than 0 and at most the ${attempt.amount.toFixed(2)} ${attempt.currency} captured, got ${amount.toFixed(2)}`,
    );
  }
}
