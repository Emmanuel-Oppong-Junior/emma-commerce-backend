import { Injectable } from '@nestjs/common';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';

export const IMPORT_RETENTION_LOCK_KEY = 70_418_001;
/** Import jobs, their rows and any file still stored are deleted this long after upload. */
export const IMPORT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTEXT = 'ImportRetentionTask';

/** Repeatable job (daily): deletes import jobs past their retention (rows cascade), except one still applying. */
@Injectable()
export class ImportRetentionTask {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async purge(now = new Date()): Promise<number | null> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(${IMPORT_RETENTION_LOCK_KEY}::bigint) AS locked`;
      if (!locked) return null;
      const result = await tx.importJob.deleteMany({
        where: {
          createdAt: { lt: new Date(now.getTime() - IMPORT_RETENTION_DAYS * DAY_MS) },
          status: { not: ImportJobStatus.APPLYING },
        },
      });
      return result.count;
    });
    if (deleted === null) {
      this.logger.log('Skipped: another instance is already purging import jobs', CONTEXT);
      return null;
    }
    this.logger.log(`Import jobs purged | jobs: ${deleted}`, CONTEXT);
    return deleted;
  }
}
