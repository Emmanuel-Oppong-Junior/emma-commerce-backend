import { Injectable } from '@nestjs/common';
import {
  Dispute,
  DisputeEvent,
  DisputeNote,
  DisputeSource,
  DisputeStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { capturedAmount } from '../../returns/refund-cap';
import { DisputedPayment } from './dispute-refund-guard';

export type DisputeRecord = Dispute & { notes: DisputeNote[]; events: DisputeEvent[] };

export interface DisputedAttempt {
  id: string;
  orderId: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
}

export interface DisputeFilter {
  status?: DisputeStatus;
  attemptId?: string;
  take: number;
}

export interface StatusChange {
  from: DisputeStatus | null;
  to: DisputeStatus;
  source: DisputeSource;
  actorId?: string | null;
  providerStatus?: string | null;
  webhookEventId?: string | null;
  note?: string | null;
}

const WITH_HISTORY = {
  notes: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
} as const;

const ATTEMPT_FIELDS = {
  id: true,
  provider: true,
  status: true,
  amount: true,
  currency: true,
  intent: { select: { orderId: true } },
} as const;

type Tx = Prisma.TransactionClient;

@Injectable()
export class DisputesRepository {
  constructor(private readonly prisma: PrismaService) {}

  runTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async findAttemptByReference(tx: Tx, provider: PaymentProvider, reference: string): Promise<DisputedAttempt | null> {
    const attempt = await tx.paymentAttempt.findFirst({ where: { provider, reference }, select: ATTEMPT_FIELDS });
    return attempt && toDisputedAttempt(attempt);
  }

  async findAttempt(tx: Tx, attemptId: string): Promise<DisputedAttempt | null> {
    const attempt = await tx.paymentAttempt.findUnique({ where: { id: attemptId }, select: ATTEMPT_FIELDS });
    return attempt && toDisputedAttempt(attempt);
  }

  /** The provider's dispute, row-locked for the rest of the transaction. */
  async lockByProviderId(tx: Tx, provider: PaymentProvider, providerDisputeId: string): Promise<Dispute | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Dispute" WHERE "provider"::text = ${provider} AND "providerDisputeId" = ${providerDisputeId}
      FOR UPDATE`;
    return row ? tx.dispute.findUniqueOrThrow({ where: { id: row.id } }) : null;
  }

  async lockById(tx: Tx, id: string): Promise<Dispute | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Dispute" WHERE "id" = ${id} FOR UPDATE`;
    return row ? tx.dispute.findUniqueOrThrow({ where: { id: row.id } }) : null;
  }

  async create(tx: Tx, data: Prisma.DisputeUncheckedCreateInput, opened: StatusChange): Promise<Dispute> {
    const dispute = await tx.dispute.create({ data });
    await this.insertEvent(tx, dispute.id, opened);
    return dispute;
  }

  /** Moves the dispute only if it is still in `change.from`, with its history row; false when it had moved on. */
  async transition(
    tx: Tx,
    id: string,
    change: StatusChange & { from: DisputeStatus },
    resolvedAt: Date | null,
  ): Promise<boolean> {
    const { count } = await tx.dispute.updateMany({
      where: { id, status: change.from },
      data: { status: change.to, ...(resolvedAt && { resolvedAt }) },
    });
    if (count === 0) return false;
    await this.insertEvent(tx, id, change);
    return true;
  }

  async update(tx: Tx, id: string, data: Prisma.DisputeUncheckedUpdateInput): Promise<void> {
    await tx.dispute.update({ where: { id }, data });
  }

  async addNote(tx: Tx, disputeId: string, authorId: string, body: string): Promise<DisputeNote> {
    return tx.disputeNote.create({ data: { disputeId, authorId, body } });
  }

  async findById(id: string, db: Tx = this.prisma): Promise<DisputeRecord | null> {
    return db.dispute.findUnique({ where: { id }, include: WITH_HISTORY });
  }

  async findMany({ status, attemptId, take }: DisputeFilter): Promise<DisputeRecord[]> {
    return this.prisma.dispute.findMany({
      where: { ...(status && { status }), ...(attemptId && { attemptId }) },
      include: WITH_HISTORY,
      orderBy: { openedAt: 'desc' },
      take,
    });
  }

  /** The refund's payment with its disputes and other refunds; null for an unknown refund. */
  async findDisputedPayment(
    refundId: string,
  ): Promise<{ payment: DisputedPayment; refund: { id: string; amount: Prisma.Decimal } } | null> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        amount: true,
        attempt: {
          select: {
            id: true,
            status: true,
            provider: true,
            reference: true,
            amount: true,
            currency: true,
            refunds: { select: { id: true, amount: true, status: true, idempotencyKey: true } },
            disputes: { select: { id: true, status: true, amount: true } },
          },
        },
      },
    });
    if (!refund) return null;
    const { disputes, refunds, ...attempt } = refund.attempt;
    return {
      refund: { id: refund.id, amount: refund.amount },
      payment: {
        attemptId: attempt.id,
        currency: attempt.currency,
        captured: capturedAmount({ attempt, refunds }),
        disputes,
        refunds,
      },
    };
  }

  private async insertEvent(tx: Tx, disputeId: string, change: StatusChange): Promise<void> {
    await tx.disputeEvent.create({
      data: {
        disputeId,
        fromStatus: change.from,
        toStatus: change.to,
        source: change.source,
        actorId: change.actorId ?? null,
        providerStatus: change.providerStatus ?? null,
        webhookEventId: change.webhookEventId ?? null,
        note: change.note ?? null,
      },
    });
  }
}

function toDisputedAttempt(attempt: {
  id: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
  intent: { orderId: string };
}): DisputedAttempt {
  const { intent, ...rest } = attempt;
  return { ...rest, orderId: intent.orderId };
}
