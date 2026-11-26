import { HttpException, Injectable } from '@nestjs/common';
import {
  ImportJobStatus,
  ImportKind,
  ImportRow,
  ImportRowAction,
  ImportRowStatus,
  PriceChangeSource,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, fieldValues } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { TaxService } from '../tax/tax.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { PriceHistoryService } from '../price-history/price-history.service';
import { ImportFactsRepository } from './import-facts.repository';
import { applyBatches } from './import-batches';
import { ParsedRow, RowOutcome } from './kinds/import-rows';
import { planProductGroup, ProductGroupPlan, productTarget } from './kinds/products-import';
import { planPriceRow } from './kinds/prices-import';
import { planStockRow, resolveLocation } from './kinds/stock-import';

type Tx = Prisma.TransactionClient;

const CONTEXT = 'ImportApplier';
const BATCH_TIMEOUT_MS = 60_000;

interface ApplyingJob {
  id: string;
  kind: ImportKind;
  actorId: string;
}

interface RowResult {
  row: ImportRow;
  status: 'APPLIED' | 'SKIPPED';
  entityId?: string;
}

/** A unit the catalogue refuses when applying; its rows become FAILED with these reasons and the batch goes on. */
class UnitRefused extends Error {
  constructor(
    readonly rows: ImportRow[],
    readonly reasons: Map<string, string[]>,
  ) {
    super('Import unit refused');
  }
}

/** Another run already moved a row out of VALID: this run stops and leaves the job to it. */
class RowAlreadyHandled extends Error {}

const rowValues = (row: ImportRow) => row.values as Record<string, string>;
const parsed = (row: ImportRow): ParsedRow => ({ rowNumber: row.rowNumber, values: rowValues(row) });

/**
 * Worker step 2: applies a job's VALID rows in batches, each batch one transaction. Every row is re-checked against
 * the catalogue as it is at that moment (the same pure rules as validation). A refused unit (a row, or the rows of
 * one product) rolls its batch back; its rows are marked FAILED and the batch is retried without it. Rows leave VALID
 * with a conditional update in the batch transaction, so a retried job never applies a row twice.
 */
@Injectable()
export class ImportApplier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: ImportFactsRepository,
    private readonly taxService: TaxService,
    private readonly ledger: StockLedgerService,
    private readonly priceHistory: PriceHistoryService,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
  ) {}

  async apply(importJobId: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!job || job.status !== ImportJobStatus.APPLYING) {
      this.logger.log(`Import job ${importJobId} is not being applied; skipped`, CONTEXT);
      return;
    }
    const applying: ApplyingJob = { id: job.id, kind: job.kind, actorId: job.appliedById ?? job.createdById };
    const pending = await this.prisma.importRow.findMany({
      where: { jobId: importJobId, status: ImportRowStatus.VALID },
      orderBy: { rowNumber: 'asc' },
    });
    const unitKey = await this.unitKeyFor(job.kind, pending);
    for (const batch of applyBatches(pending, unitKey)) {
      try {
        await this.applyBatch(applying, batch);
      } catch (error) {
        if (error instanceof RowAlreadyHandled) {
          this.logger.warn(`Import job ${importJobId}: another run applied these rows; this run stops`, CONTEXT);
          return;
        }
        throw error;
      }
    }
    await this.complete(applying);
  }

  /** PRODUCTS rows apply per product (their target); PRICES and STOCK rows one by one. */
  private async unitKeyFor(kind: ImportKind, rows: ImportRow[]): Promise<(row: ImportRow) => string> {
    if (kind !== ImportKind.PRODUCTS) return (row) => row.id;
    const skus = rows.flatMap((row) => (rowValues(row).sku ? [rowValues(row).sku] : []));
    const productIds = await this.facts.productIdsBySku(this.prisma, skus);
    return (row) => productTarget(rowValues(row), productIds);
  }

  private async applyBatch(job: ApplyingJob, units: ImportRow[][]): Promise<void> {
    let remaining = units;
    while (remaining.length > 0) {
      try {
        const taxRate = await this.taxService.getTotalActiveRate();
        await this.prisma.$transaction(
          async (tx) => {
            for (const unit of remaining) {
              const results = await this.refusingOn(unit, () => this.applyUnit(tx, job, unit, taxRate));
              for (const result of results) await this.markDone(tx, result);
            }
          },
          { timeout: BATCH_TIMEOUT_MS },
        );
        return;
      } catch (error) {
        if (!(error instanceof UnitRefused)) throw error;
        await this.markFailed(error);
        const refused = new Set(error.rows.map((row) => row.id));
        remaining = remaining.filter((unit) => !unit.some((row) => refused.has(row.id)));
      }
    }
  }

  /** Domain refusals (4xx from the services, unique clashes) become a UnitRefused for the unit; anything else rethrows. */
  private async refusingOn(unit: ImportRow[], work: () => Promise<RowResult[]>): Promise<RowResult[]> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UnitRefused || error instanceof RowAlreadyHandled) throw error;
      const refused =
        (error instanceof HttpException && error.getStatus() < 500) ||
        (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003'].includes(error.code));
      if (!refused) throw error;
      const reason =
        error instanceof HttpException
          ? error.message
          : 'A SKU or barcode in this row is already in use (changed meanwhile)';
      throw new UnitRefused(unit, new Map(unit.map((row) => [row.id, [reason]])));
    }
  }

  private applyUnit(tx: Tx, job: ApplyingJob, unit: ImportRow[], taxRate: Prisma.Decimal): Promise<RowResult[]> {
    if (job.kind === ImportKind.PRICES) return this.applyPrice(tx, job, unit[0], taxRate);
    if (job.kind === ImportKind.STOCK) return this.applyStock(tx, job, unit[0]);
    return this.applyProducts(tx, job, unit, taxRate);
  }

  private refuse(rows: ImportRow[], outcomes: Map<number, RowOutcome>): never {
    throw new UnitRefused(rows, new Map(rows.map((row) => [row.id, outcomes.get(row.rowNumber)?.errors ?? []])));
  }

  private async applyPrice(tx: Tx, job: ApplyingJob, row: ImportRow, taxRate: Prisma.Decimal): Promise<RowResult[]> {
    const sku = rowValues(row).sku ?? '';
    await this.facts.lockVariantsBySku(tx, [sku]);
    const variant = (await this.facts.priceFacts(tx, [sku])).get(sku.toLowerCase());
    const outcome = planPriceRow(rowValues(row), variant, taxRate);
    if (outcome.errors.length) this.refuse([row], new Map([[row.rowNumber, outcome]]));
    if (outcome.action === ImportRowAction.NONE || !outcome.plan) return [{ row, status: 'SKIPPED' }];
    const { variantId, basePrice, price, reason } = outcome.plan;
    const updated = await tx.variant.update({
      where: { id: variantId },
      data: { basePrice, price },
      select: { basePrice: true, price: true },
    });
    await this.priceHistory.recordVariantPrices(tx, variantId, variant!, updated, {
      source: PriceChangeSource.IMPORT,
      actorId: job.actorId,
      reason: reason ?? `Import ${job.id}`,
    });
    return [{ row, status: 'APPLIED', entityId: variantId }];
  }

  private async applyStock(tx: Tx, job: ApplyingJob, row: ImportRow): Promise<RowResult[]> {
    const values = rowValues(row);
    const variant = (await this.facts.stockVariantFacts(tx, [values.sku ?? ''])).get((values.sku ?? '').toLowerCase());
    const locations = await this.facts.locations(tx);
    const location = resolveLocation(values.location, locations);
    const level = variant && 'id' in location ? await this.facts.lockStockLevel(tx, variant.id, location.id) : null;
    const outcome = planStockRow(values, variant, locations, level);
    if (outcome.errors.length) this.refuse([row], new Map([[row.rowNumber, outcome]]));
    if (outcome.action === ImportRowAction.NONE || !outcome.plan) return [{ row, status: 'SKIPPED' }];
    const { variantId, locationId, delta, reason, note } = outcome.plan;
    const movement = await this.ledger.adjustAt(tx, variantId, locationId, delta, {
      adjustmentReason: reason,
      note: note ?? undefined,
      actorId: job.actorId,
      refType: 'ImportJob',
      refId: job.id,
    });
    if (!movement) {
      const available = await this.ledger.availableAt(tx, variantId, locationId);
      throw new UnitRefused(
        [row],
        new Map([[row.id, [`Cannot remove ${-delta} unit(s): only ${available} available`]]]),
      );
    }
    return [{ row, status: 'APPLIED', entityId: movement.id }];
  }

  private async applyProducts(
    tx: Tx,
    job: ApplyingJob,
    unit: ImportRow[],
    taxRate: Prisma.Decimal,
  ): Promise<RowResult[]> {
    const rows = unit.map(parsed);
    await this.facts.lockVariantsBySku(
      tx,
      rows.flatMap((row) => (row.values.sku ? [row.values.sku] : [])),
    );
    const facts = await this.facts.catalogueFacts(tx, rows, taxRate);
    const { rows: outcomes, plan } = planProductGroup(rows, facts);
    if (!plan) this.refuse(unit, outcomes);
    const productId = await this.writeProduct(tx, job, plan);
    const variantIds = new Map<number, string>();
    for (const step of plan.variants) {
      if (step.kind === 'update') {
        await tx.variant.update({ where: { id: step.id }, data: step.data });
        variantIds.set(step.rowNumber, step.id);
        continue;
      }
      const created = await tx.variant.create({ data: { ...step.data, productId } });
      await this.priceHistory.recordVariantPrices(tx, created.id, null, created, {
        source: PriceChangeSource.IMPORT,
        actorId: job.actorId,
        reason: `Import ${job.id}`,
      });
      variantIds.set(step.rowNumber, created.id);
    }
    return unit.map((row) => {
      const action = outcomes.get(row.rowNumber)!.action;
      if (action === ImportRowAction.NONE) return { row, status: 'SKIPPED' };
      return { row, status: 'APPLIED', entityId: variantIds.get(row.rowNumber) ?? productId };
    });
  }

  /** Creates or updates the product (audited like an admin edit, naming the import job); returns its id. */
  private async writeProduct(tx: Tx, job: ApplyingJob, plan: ProductGroupPlan): Promise<string> {
    const tags = plan.tagIds.length ? { tags: { connect: plan.tagIds.map((id) => ({ id })) } } : {};
    if (plan.product.kind === 'create') {
      const product = await tx.product.create({ data: { ...plan.product.data, ...tags } });
      await this.auditService.log(
        {
          entity: 'Product',
          entityId: product.id,
          action: 'CREATE',
          userId: job.actorId,
          details: {
            importJobId: job.id,
            after: fieldValues(product, ['name', 'productTypeId', 'attributes', 'isTaxable', 'status']),
            variants: plan.variants.filter((step) => step.kind === 'create').length,
          },
        },
        tx,
      );
      return product.id;
    }
    const { id, data } = plan.product;
    if (Object.keys(data).length > 0 || plan.tagIds.length > 0) {
      await tx.product.update({ where: { id }, data: { ...data, ...tags } });
      await this.auditService.log(
        {
          entity: 'Product',
          entityId: id,
          action: 'UPDATE',
          userId: job.actorId,
          details: JSON.parse(JSON.stringify({ importJobId: job.id, changes: data, addedTagIds: plan.tagIds })),
        },
        tx,
      );
    }
    return id;
  }

  private async markDone(tx: Tx, result: RowResult): Promise<void> {
    const applied = result.status === 'APPLIED';
    const moved = await tx.importRow.updateMany({
      where: { id: result.row.id, status: ImportRowStatus.VALID },
      data: {
        status: applied ? ImportRowStatus.APPLIED : ImportRowStatus.SKIPPED,
        appliedAt: applied ? new Date() : null,
        entityId: result.entityId ?? null,
      },
    });
    if (moved.count === 0) throw new RowAlreadyHandled();
  }

  private async markFailed(refusal: UnitRefused): Promise<void> {
    await this.prisma.$transaction(
      refusal.rows.map((row) =>
        this.prisma.importRow.updateMany({
          where: { id: row.id, status: ImportRowStatus.VALID },
          data: { status: ImportRowStatus.FAILED, errors: refusal.reasons.get(row.id) ?? [] },
        }),
      ),
    );
  }

  private async complete(job: ApplyingJob): Promise<void> {
    const counts = await this.prisma.importRow.groupBy({ by: ['status'], where: { jobId: job.id }, _count: true });
    const count = (status: ImportRowStatus) => counts.find((c) => c.status === status)?._count ?? 0;
    const totals = {
      appliedRows: count(ImportRowStatus.APPLIED),
      skippedRows: count(ImportRowStatus.SKIPPED),
      failedRows: count(ImportRowStatus.FAILED),
    };
    await this.auditService.record(
      (tx) =>
        tx.importJob.updateMany({
          where: { id: job.id, status: ImportJobStatus.APPLYING },
          data: { status: ImportJobStatus.COMPLETED, completedAt: new Date(), ...totals },
        }),
      () => ({
        entity: 'ImportJob',
        entityId: job.id,
        action: 'STATUS_CHANGE',
        userId: job.actorId,
        details: { from: ImportJobStatus.APPLYING, to: ImportJobStatus.COMPLETED, kind: job.kind, ...totals },
      }),
    );
    this.logger.log(
      `Import job ${job.id} applied | applied: ${totals.appliedRows} | skipped: ${totals.skippedRows} | failed: ${totals.failedRows}`,
      CONTEXT,
    );
  }
}
