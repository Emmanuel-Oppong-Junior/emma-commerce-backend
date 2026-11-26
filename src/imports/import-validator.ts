import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ImportJobStatus, ImportKind, ImportRowStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { TaxService } from '../tax/tax.service';
import { JobQueue } from '../jobs/job-queues';
import { withJobMeta } from '../jobs/job-context';
import { ImportFileError } from './spreadsheet/file-format';
import { readTable, Table } from './spreadsheet/table-reader';
import { headerProblems, RowOutcome } from './kinds/import-rows';
import { IMPORT_COLUMNS, validatePriceRows, validateProductRows, validateStockRows } from './kinds/import-kinds';
import { ImportFactsRepository } from './import-facts.repository';
import { importStatusesBefore } from './import-job-status';
import { applyQueueJobId, IMPORT_APPLY_JOB, ImportQueueJobData } from './import-queue';

const CONTEXT = 'ImportValidator';
const INSERT_CHUNK = 1000;

/**
 * Worker step 1 (dry run): parses the stored file, checks every row against the catalogue as it is now and stores one
 * ImportRow per data row with its errors, warnings and planned action, then clears the file. Nothing in the catalogue
 * changes. A file that cannot be read fails the job with the reason.
 */
@Injectable()
export class ImportValidator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: ImportFactsRepository,
    private readonly taxService: TaxService,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
    @InjectQueue(JobQueue.IMPORTS) private readonly queue: Queue,
  ) {}

  async validate(importJobId: string): Promise<void> {
    const claimed = await this.prisma.importJob.updateMany({
      where: { id: importJobId, status: { in: importStatusesBefore(ImportJobStatus.VALIDATING) } },
      data: { status: ImportJobStatus.VALIDATING },
    });
    if (claimed.count === 0) {
      this.logger.log(`Import job ${importJobId} is no longer waiting for validation; skipped`, CONTEXT);
      return;
    }
    const job = await this.prisma.importJob.findUniqueOrThrow({ where: { id: importJobId } });
    if (!job.file) return this.fail(importJobId, 'The uploaded file is no longer stored; upload it again');

    let table: Table;
    try {
      table = await readTable(Buffer.from(job.file), job.format, job.sheetName);
    } catch (error) {
      if (error instanceof ImportFileError) return this.fail(importJobId, error.message);
      throw error;
    }
    const problems = headerProblems(table.header, IMPORT_COLUMNS[job.kind]);
    if (problems.length) return this.fail(importJobId, problems.join('; '));

    const outcomes = await this.check(job.kind, table);
    const rows = table.rows.map((row) => {
      const outcome = outcomes.get(row.rowNumber)!;
      return {
        jobId: importJobId,
        rowNumber: row.rowNumber,
        sku: row.values.sku?.slice(0, 255) ?? null,
        status: outcome.errors.length ? ImportRowStatus.INVALID : ImportRowStatus.VALID,
        action: outcome.action,
        values: row.values,
        errors: outcome.errors,
        warnings: outcome.warnings,
      };
    });
    const validRows = rows.filter((row) => row.status === ImportRowStatus.VALID).length;
    const validated = await this.prisma.$transaction(async (tx) => {
      // A retried run starts over.
      await tx.importRow.deleteMany({ where: { jobId: importJobId } });
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        await tx.importRow.createMany({ data: rows.slice(start, start + INSERT_CHUNK) });
      }
      const moved = await tx.importJob.updateMany({
        where: { id: importJobId, status: ImportJobStatus.VALIDATING },
        data: {
          status: ImportJobStatus.VALIDATED,
          validatedAt: new Date(),
          file: null,
          totalRows: rows.length,
          validRows,
          invalidRows: rows.length - validRows,
        },
      });
      return moved.count === 1;
    });
    if (!validated) return;
    this.logger.log(
      `Import job ${importJobId} validated | kind: ${job.kind} | rows: ${rows.length} | valid: ${validRows}`,
      CONTEXT,
    );
    if (job.applyAfterValidation) await this.startApply(importJobId, job.createdById);
  }

  private async check(kind: ImportKind, table: Table): Promise<Map<number, RowOutcome>> {
    const skus = table.rows.flatMap((row) => (row.values.sku ? [row.values.sku] : []));
    if (kind === ImportKind.PRODUCTS) {
      const taxRate = await this.taxService.getTotalActiveRate();
      return validateProductRows(table.rows, await this.facts.catalogueFacts(this.prisma, table.rows, taxRate));
    }
    if (kind === ImportKind.PRICES) {
      const taxRate = await this.taxService.getTotalActiveRate();
      return validatePriceRows(table.rows, await this.facts.priceFacts(this.prisma, skus), taxRate);
    }
    const variants = await this.facts.stockVariantFacts(this.prisma, skus);
    const [locations, levels] = await Promise.all([
      this.facts.locations(this.prisma),
      this.facts.stockLevels(
        this.prisma,
        [...variants.values()].map((variant) => variant.id),
      ),
    ]);
    return validateStockRows(table.rows, variants, locations, levels);
  }

  /** Upload without a dry run: the uploader applies the valid rows straight away. */
  private async startApply(importJobId: string, actorId: string): Promise<void> {
    const run = await this.auditService.record(
      async (tx) => {
        await tx.importJob.update({
          where: { id: importJobId, status: ImportJobStatus.VALIDATED },
          data: { status: ImportJobStatus.APPLYING, applyRuns: { increment: 1 }, appliedById: actorId },
        });
        return (await tx.importJob.findUniqueOrThrow({ where: { id: importJobId } })).applyRuns;
      },
      (applyRun) => ({
        entity: 'ImportJob',
        entityId: importJobId,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from: ImportJobStatus.VALIDATED, to: ImportJobStatus.APPLYING, run: applyRun, automatic: true },
      }),
    );
    const data: ImportQueueJobData = { importJobId };
    await this.queue.add(IMPORT_APPLY_JOB, withJobMeta(data), { jobId: applyQueueJobId(importJobId, run) });
  }

  private async fail(importJobId: string, error: string): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: { id: importJobId, status: ImportJobStatus.VALIDATING },
      data: { status: ImportJobStatus.FAILED, error: error.slice(0, 1000), file: null },
    });
    this.logger.warn(`Import job ${importJobId} failed validation | ${error.slice(0, 200)}`, CONTEXT);
  }
}
