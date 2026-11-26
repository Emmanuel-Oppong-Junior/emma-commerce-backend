import { ImportRowStatus } from '../generated/prisma/client';

export const APPLY_BATCH_ROWS = 50;

/**
 * Splits the rows still to apply into batches of whole units (the rows of one product, or a single row), at most
 * `maxRows` rows per batch unless one unit is larger. Only VALID rows are taken: a row leaves VALID once it is
 * applied, skipped or refused, so re-running an apply (a retried job) never applies a row twice.
 */
export function applyBatches<T extends { rowNumber: number; status: ImportRowStatus }>(
  rows: readonly T[],
  unitKey: (row: T) => string,
  maxRows = APPLY_BATCH_ROWS,
): T[][][] {
  const units = new Map<string, T[]>();
  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    if (row.status !== ImportRowStatus.VALID) continue;
    const key = unitKey(row);
    units.set(key, [...(units.get(key) ?? []), row]);
  }
  const batches: T[][][] = [];
  let batch: T[][] = [];
  let size = 0;
  for (const unit of units.values()) {
    if (batch.length > 0 && size + unit.length > maxRows) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(unit);
    size += unit.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
