import { Prisma } from '../generated/prisma/client';

export const IMPORT_VALIDATE_JOB = 'import.validate';
export const IMPORT_APPLY_JOB = 'import.apply';

export interface ImportQueueJobData {
  importJobId: string;
}

/** Every ImportJob column but the file bytes. */
export const IMPORT_JOB_FIELDS = {
  id: true,
  kind: true,
  status: true,
  format: true,
  fileName: true,
  sheetName: true,
  fileSize: true,
  applyAfterValidation: true,
  applyRuns: true,
  totalRows: true,
  validRows: true,
  invalidRows: true,
  appliedRows: true,
  skippedRows: true,
  failedRows: true,
  error: true,
  createdById: true,
  appliedById: true,
  createdAt: true,
  updatedAt: true,
  validatedAt: true,
  completedAt: true,
  cancelledAt: true,
} satisfies Prisma.ImportJobSelect;

export type ImportJobRecord = Prisma.ImportJobGetPayload<{ select: typeof IMPORT_JOB_FIELDS }>;

/** BullMQ job ids: one validation per import, one id per apply run (a re-run after a failure is a new job). */
export const validateQueueJobId = (importJobId: string) => `${importJobId}-validate`;
export const applyQueueJobId = (importJobId: string, run: number) => `${importJobId}-apply-${run}`;
