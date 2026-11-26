import { ImportJobStatus } from '../generated/prisma/client';

const S = ImportJobStatus;

// VALIDATING → VALIDATING is a retried validation run; FAILED → APPLYING re-runs an apply that ran out of attempts
// (only for a validated job: ImportsService checks validatedAt), skipping the rows already applied.
const NEXT: Record<ImportJobStatus, readonly ImportJobStatus[]> = {
  [S.QUEUED]: [S.VALIDATING, S.CANCELLED, S.FAILED],
  [S.VALIDATING]: [S.VALIDATING, S.VALIDATED, S.FAILED],
  [S.VALIDATED]: [S.APPLYING, S.CANCELLED],
  [S.APPLYING]: [S.COMPLETED, S.FAILED],
  [S.FAILED]: [S.APPLYING],
  [S.COMPLETED]: [],
  [S.CANCELLED]: [],
};

export function canMoveImportJob(from: ImportJobStatus, to: ImportJobStatus): boolean {
  return NEXT[from].includes(to);
}

/** The statuses a job may move to `to` from. */
export function importStatusesBefore(to: ImportJobStatus): ImportJobStatus[] {
  return (Object.keys(NEXT) as ImportJobStatus[]).filter((from) => canMoveImportJob(from, to));
}
