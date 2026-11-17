import { Prisma } from '@prisma/client';
import { AuditEntry } from '../../src/commons/audit.service';

export const AUDIT_TX = { auditTransaction: true } as unknown as Prisma.TransactionClient;

/**
 * AuditService stand-in for unit tests: `record` runs the change with AUDIT_TX and logs the entry built from its
 * result on the same client, so tests can assert both the entry and that the write went through the transaction.
 */
export function createAuditServiceMock() {
  const log = jest.fn<Promise<void>, [AuditEntry, Prisma.TransactionClient?]>().mockResolvedValue(undefined);
  const record = jest.fn(
    async <T>(change: (tx: Prisma.TransactionClient) => Promise<T>, entry: (result: T) => AuditEntry): Promise<T> => {
      const result = await change(AUDIT_TX);
      await log(entry(result), AUDIT_TX);
      return result;
    },
  );
  return { log, record };
}

/** Drops undefined keys the way Prisma ignores them in update data, for repository mocks that echo the update. */
export function withoutUndefined<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as Partial<T>;
}
