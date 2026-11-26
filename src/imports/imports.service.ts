import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ImportFileFormat,
  ImportJobStatus,
  ImportKind,
  ImportRow,
  ImportRowStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { withJobMeta } from '../jobs/job-context';
import { detectImportFormat, ImportFileError } from './spreadsheet/file-format';
import { CellValue, SpreadsheetFormat, toSpreadsheet } from './spreadsheet/table-writer';
import { importStatusesBefore } from './import-job-status';
import { importTemplate } from './kinds/import-kinds';
import {
  applyQueueJobId,
  IMPORT_APPLY_JOB,
  IMPORT_JOB_FIELDS,
  IMPORT_VALIDATE_JOB,
  ImportJobRecord,
  ImportQueueJobData,
  validateQueueJobId,
} from './import-queue';

const CONTEXT = 'ImportsService';
const MAX_PAGE_SIZE = 100;
const MAX_SHEET_NAME_LENGTH = 100;

export interface UploadedImportFile {
  buffer: Buffer;
  originalname: string;
}

export interface ImportJobPage {
  nodes: ImportJobRecord[];
  totalCount: number;
  hasNextPage: boolean;
}

export interface ImportRowPage {
  nodes: ImportRow[];
  totalCount: number;
  hasNextPage: boolean;
}

export const CATALOG_IMPORT_KINDS: readonly ImportKind[] = [ImportKind.PRODUCTS, ImportKind.PRICES];
export const STOCK_IMPORT_KINDS: readonly ImportKind[] = [ImportKind.STOCK];

/**
 * Staff-facing side of bulk imports (P8-I): upload (the file is sniffed, stored privately and queued for validation),
 * listing, the per-row report, apply and cancel. Validation and apply run in the worker (ImportValidator,
 * ImportApplier). `kinds` limits each call to the kinds the caller's permission covers.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
    @InjectQueue(JobQueue.IMPORTS) private readonly queue: Queue,
  ) {}

  /**
   * Stores the file as a QUEUED job and queues its validation. With `apply`, the valid rows are applied as soon as
   * validation ends; otherwise the job waits, validated, for staff to apply or cancel it.
   * @throws BadRequestException for an empty, oversized, macro-enabled or unsupported file, or a sheet name on a CSV.
   */
  async upload(
    kind: ImportKind,
    file: UploadedImportFile | undefined,
    options: { sheet?: string; apply: boolean },
    actorId: string,
  ): Promise<ImportJobRecord> {
    if (!file) throw new BadRequestException('No file was uploaded: send it in the "file" field');
    let format: ImportFileFormat;
    try {
      format = detectImportFormat(file.buffer);
    } catch (error) {
      if (error instanceof ImportFileError) throw new BadRequestException(error.message);
      throw error;
    }
    const sheet = options.sheet?.trim() || null;
    if (sheet && format === ImportFileFormat.CSV)
      throw new BadRequestException('A CSV file has no sheets: leave sheet out');
    if (sheet && sheet.length > MAX_SHEET_NAME_LENGTH) {
      throw new BadRequestException(`sheet must be at most ${MAX_SHEET_NAME_LENGTH} characters`);
    }
    const job = await this.auditService.record(
      (tx) =>
        tx.importJob.create({
          data: {
            kind,
            format,
            fileName: file.originalname.slice(0, 255) || 'upload',
            sheetName: sheet,
            fileSize: file.buffer.length,
            file: new Uint8Array(file.buffer),
            applyAfterValidation: options.apply,
            createdById: actorId,
          },
          select: IMPORT_JOB_FIELDS,
        }),
      (created) => ({
        entity: 'ImportJob',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { kind, format, fileName: created.fileName, fileSize: created.fileSize, apply: options.apply },
      }),
    );
    await this.enqueue(job.id, IMPORT_VALIDATE_JOB, validateQueueJobId(job.id));
    return job;
  }

  async list(kinds: readonly ImportKind[], first: number, after?: string): Promise<ImportJobPage> {
    const take = Math.min(Math.max(first, 1), MAX_PAGE_SIZE);
    const where = { kind: { in: [...kinds] } };
    const [rows, totalCount] = await Promise.all([
      this.prisma.importJob.findMany({
        where,
        select: IMPORT_JOB_FIELDS,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(after && { cursor: { id: after }, skip: 1 }),
      }),
      this.prisma.importJob.count({ where }),
    ]);
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /** @throws NotFoundException when the job does not exist or is of a kind outside `kinds`. */
  async get(id: string, kinds: readonly ImportKind[]): Promise<ImportJobRecord> {
    const job = await this.prisma.importJob.findFirst({
      where: { id, kind: { in: [...kinds] } },
      select: IMPORT_JOB_FIELDS,
    });
    if (!job) throw new NotFoundException(`Import job "${id}" not found`);
    return job;
  }

  async rows(
    jobId: string,
    status: ImportRowStatus | undefined,
    first: number,
    after?: string,
  ): Promise<ImportRowPage> {
    const take = Math.min(Math.max(first, 1), MAX_PAGE_SIZE);
    const where: Prisma.ImportRowWhereInput = { jobId, ...(status && { status }) };
    const [rows, totalCount] = await Promise.all([
      this.prisma.importRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        take: take + 1,
        ...(after && { cursor: { id: after }, skip: 1 }),
      }),
      this.prisma.importRow.count({ where }),
    ]);
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /**
   * Starts applying a validated job (or re-runs an apply that failed: rows already applied are skipped).
   * @throws NotFoundException for an unknown job or one of another kind; ConflictException when it is not validated.
   */
  async apply(id: string, kinds: readonly ImportKind[], actorId: string): Promise<ImportJobRecord> {
    const current = await this.get(id, kinds);
    const job = await this.auditService.record(
      async (tx) => {
        const moved = await tx.importJob.updateMany({
          where: { id, status: { in: importStatusesBefore(ImportJobStatus.APPLYING) }, validatedAt: { not: null } },
          data: { status: ImportJobStatus.APPLYING, applyRuns: { increment: 1 }, appliedById: actorId, error: null },
        });
        if (moved.count === 0) {
          throw new ConflictException(`Import job "${id}" is ${current.status}; only a validated job can be applied`);
        }
        return tx.importJob.findUniqueOrThrow({ where: { id }, select: IMPORT_JOB_FIELDS });
      },
      (applying) => ({
        entity: 'ImportJob',
        entityId: id,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from: current.status, to: applying.status, run: applying.applyRuns, validRows: applying.validRows },
      }),
    );
    await this.enqueue(id, IMPORT_APPLY_JOB, applyQueueJobId(id, job.applyRuns));
    return job;
  }

  /** @throws ConflictException unless the job is still queued or validated (not yet applied). */
  async cancel(id: string, kinds: readonly ImportKind[], actorId: string): Promise<ImportJobRecord> {
    const current = await this.get(id, kinds);
    return this.auditService.record(
      async (tx) => {
        const moved = await tx.importJob.updateMany({
          where: { id, status: { in: importStatusesBefore(ImportJobStatus.CANCELLED) } },
          data: { status: ImportJobStatus.CANCELLED, cancelledAt: new Date(), file: null },
        });
        if (moved.count === 0) {
          throw new ConflictException(
            `Import job "${id}" is ${current.status}; only a queued or validated job can be cancelled`,
          );
        }
        return tx.importJob.findUniqueOrThrow({ where: { id }, select: IMPORT_JOB_FIELDS });
      },
      () => ({
        entity: 'ImportJob',
        entityId: id,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from: current.status, to: ImportJobStatus.CANCELLED },
      }),
    );
  }

  /** The validation (and apply) report of a job, one line per data row. */
  async report(id: string, kinds: readonly ImportKind[], format: SpreadsheetFormat): Promise<Buffer> {
    await this.get(id, kinds);
    const rows = await this.prisma.importRow.findMany({ where: { jobId: id }, orderBy: { rowNumber: 'asc' } });
    const header = ['row', 'sku', 'status', 'action', 'errors', 'warnings', 'entity_id'];
    const lines: CellValue[][] = rows.map((row) => [
      row.rowNumber,
      row.sku,
      row.status,
      row.action,
      row.errors.join('; '),
      row.warnings.join('; '),
      row.entityId,
    ]);
    return toSpreadsheet(format, header, lines, 'Report');
  }

  template(kind: ImportKind, format: SpreadsheetFormat): Promise<Buffer> {
    const { header, example } = importTemplate(kind);
    return toSpreadsheet(format, header, [example], kind.toLowerCase());
  }

  private async enqueue(importJobId: string, name: string, jobId: string): Promise<void> {
    const data: ImportQueueJobData = { importJobId };
    try {
      await this.queue.add(name, withJobMeta(data), { jobId });
    } catch (error) {
      // Without its queue job the import would wait forever; fail it so staff see why and upload again.
      await this.prisma.importJob.update({
        where: { id: importJobId },
        data: { status: ImportJobStatus.FAILED, error: 'The job could not be queued; upload the file again' },
      });
      this.logger.error(`Could not queue ${name} for import job ${importJobId}`, (error as Error).stack, CONTEXT);
      throw error;
    }
  }
}
