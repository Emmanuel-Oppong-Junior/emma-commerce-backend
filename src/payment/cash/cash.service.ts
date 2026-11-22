import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../commons/audit.service';
import { LoggerService } from '../../commons/logger.service';
import { OutboxService } from '../../outbox/outbox.service';
import { StoreRepository } from '../../store/store.repository';
import { AppMetrics } from '../../observability/metrics';
import {
  assertCollectionsRemittable,
  assertReceivedAt,
  assertRemittanceNotEmpty,
  assertRemittingRider,
  discrepancyKind,
  remittanceNote,
  remittanceTotals,
} from './cash-remittance';
import { assertReportRange, buildRiderCashReport, RiderCashReport, RiderPage } from './cash-report';
import { CashRepository, CollectionRecord, RemittanceRecord, UncollectedDeliveryRow } from './cash.repository';

const CONTEXT = 'CashRemittance';

export interface RecordRemittanceParams {
  riderId: string;
  amount: Prisma.Decimal;
  collectionIds: string[];
  receivedAt?: Date;
  note?: string | null;
}

export interface CodCashReportParams extends RiderPage {
  from: Date;
  to: Date;
  riderId?: string;
}

export interface CodCashReportResult extends RiderCashReport {
  from: Date;
  to: Date;
  uncollectedDeliveries: { count: number; total: Prisma.Decimal; orders: UncollectedDeliveryRow[] };
}

/**
 * Cash-on-delivery cash after collection (P3-B.3): riders (staff accounts for now) hand the cash they collected to the
 * store as remittances, each covering a set of their unremitted collections; the difference is recorded as a short or
 * over discrepancy with a note. Remittances are immutable and every one is audited.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly repository: CashRepository,
    private readonly storeRepository: StoreRepository,
    private readonly auditService: AuditService,
    private readonly outbox: OutboxService,
    private readonly metrics: AppMetrics,
    private readonly logger: LoggerService,
  ) {}

  findUnremittedCollections(riderId: string): Promise<CollectionRecord[]> {
    return this.repository.findUnremittedCollections(riderId);
  }

  findRemittances(riderId: string | undefined, take: number): Promise<RemittanceRecord[]> {
    return this.repository.findRemittances(riderId, take);
  }

  /**
   * Records cash a rider handed in, covering the listed collections (each remitted at most once: the collections are
   * row-locked and linked with a conditional update, so a concurrent remittance of the same collection gets CONFLICT).
   * A non-zero difference needs a note and records `cod.remittance_discrepancy.v1`.
   */
  async recordRemittance(params: RecordRemittanceParams, receivedById: string): Promise<RemittanceRecord> {
    const { riderId, amount, collectionIds } = params;
    assertRemittanceNotEmpty(collectionIds, amount);
    const now = new Date();
    const receivedAt = params.receivedAt ?? now;
    assertReceivedAt(receivedAt, now);

    const remittance = await this.repository.runTransaction(async (tx) => {
      assertRemittingRider(await this.repository.findRemittingRider(tx, riderId), riderId);
      const collections = await this.repository.lockCollections(tx, collectionIds);
      assertCollectionsRemittable(collectionIds, collections, riderId);
      const totals = remittanceTotals(collections, amount);
      const note = remittanceNote(totals, params.note);

      const created = await this.repository.createRemittance(tx, {
        riderId,
        receivedById,
        amount,
        expectedAmount: totals.expectedAmount,
        discrepancy: totals.discrepancy,
        currency: await this.storeRepository.findCurrency(tx),
        note,
        receivedAt,
      });
      const linked = await this.repository.linkCollections(tx, created.id, riderId, collectionIds);
      if (linked !== collectionIds.length) {
        throw new ConflictException('A collection was remitted by another request; reload and try again');
      }
      await this.auditService.log(
        {
          entity: 'CashRemittance',
          entityId: created.id,
          action: 'CREATE',
          userId: receivedById,
          details: {
            riderId,
            amount: amount.toFixed(2),
            expectedAmount: totals.expectedAmount.toFixed(2),
            discrepancy: totals.discrepancy.toFixed(2),
            currency: created.currency,
            collectionIds,
            receivedAt: receivedAt.toISOString(),
            ...(note && { note }),
          },
        },
        tx,
      );
      if (totals.kind) {
        await this.outbox.record(tx, {
          type: 'cod.remittance_discrepancy.v1',
          aggregateId: created.id,
          payload: { remittanceId: created.id, riderId, kind: totals.kind },
        });
      }
      return this.repository.findRemittance(tx, created.id);
    });

    const kind = discrepancyKind(remittance.discrepancy);
    if (kind) this.metrics.recordCodRemittanceDiscrepancy(kind);
    this.logger.log(
      `Cash remittance recorded | remittanceId: ${remittance.id} | riderId: ${riderId} | collections: ${collectionIds.length} | discrepancy: ${remittance.discrepancy.toFixed(2)} | receivedById: ${receivedById}`,
      CONTEXT,
    );
    return remittance;
  }

  /**
   * Per rider for [from, to): collections taken (and those still unremitted), remittances received and their
   * discrepancies; plus the cash-on-delivery orders delivered in the range with no cash recorded (store-wide).
   */
  async report(params: CodCashReportParams): Promise<CodCashReportResult> {
    const { from, to, riderId } = params;
    assertReportRange(from, to);
    const [rows, uncollectedDeliveries] = await Promise.all([
      this.repository.findRiderCashRows(from, to, riderId),
      this.repository.findUncollectedDeliveries(from, to),
    ]);
    return { from, to, ...buildRiderCashReport(rows, params), uncollectedDeliveries };
  }
}
