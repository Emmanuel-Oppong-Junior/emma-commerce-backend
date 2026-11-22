import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { DomainEventPayloads } from '../../outbox/domain-events';
import { LowStockAlertsRepository } from './low-stock-alerts.repository';
import { DigestSection, digestSections, planDigest } from './low-stock-digest';

export const LOW_STOCK_DIGEST_LOCK_KEY = 70_412_005;
const MAX_RUN_MS = 2 * 60 * 1000;

export interface DigestRun {
  /** Null when no digest was sent: nothing pending, or every pending variant recovered */
  digestId: string | null;
  listed: number;
  dropped: number;
  recipients: number;
}

/**
 * Low-stock alerts for staff (P4-B.2): each `inventory.low_stock.v1` event becomes a PENDING alert (one per variant
 * and location until a digest lists it), and the digest job lists the variants still low in one email per staff
 * member holding inventory.alerts, through the outbox in the same transaction that marks the alerts SENT.
 */
@Injectable()
export class LowStockAlertsService {
  constructor(
    private readonly repository: LowStockAlertsRepository,
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
  ) {}

  recordPending(eventId: string, payload: DomainEventPayloads['inventory.low_stock.v1']): Promise<boolean> {
    return this.repository.recordPending(eventId, payload);
  }

  /**
   * Lists the pending alerts still low under `digestId`, drops the recovered ones and records one
   * `inventory.low_stock_digest.v1` per recipient, in one transaction. Null when another run holds the lock.
   */
  async sendDigest(digestId: string, now: Date): Promise<DigestRun | null> {
    return this.prisma.$transaction(
      async (tx) => {
        if (!(await this.repository.tryAdvisoryLock(tx, LOW_STOCK_DIGEST_LOCK_KEY))) return null;
        const plan = planDigest(await this.repository.lockPending(tx));
        if (plan.drop.length > 0) {
          await this.repository.markDropped(
            tx,
            plan.drop.map((alert) => alert.id),
            now,
          );
        }
        if (plan.send.length === 0) return { digestId: null, listed: 0, dropped: plan.drop.length, recipients: 0 };
        await this.repository.markSent(tx, digestId, plan.send, now);
        const recipients = await this.repository.alertRecipientIds(tx);
        for (const recipientId of recipients) {
          await this.outbox.record(tx, {
            type: 'inventory.low_stock_digest.v1',
            aggregateId: digestId,
            payload: { digestId, recipientId },
          });
        }
        return { digestId, listed: plan.send.length, dropped: plan.drop.length, recipients: recipients.length };
      },
      { timeout: MAX_RUN_MS },
    );
  }

  async digestSections(digestId: string): Promise<DigestSection[]> {
    return digestSections(await this.repository.digestItems(digestId));
  }
}
