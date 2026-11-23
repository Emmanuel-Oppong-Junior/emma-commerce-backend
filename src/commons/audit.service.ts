import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'ARCHIVE'
  | 'RESTORE'
  | 'STATUS_CHANGE'
  | 'REFUND'
  | 'STOCK_ADJUSTMENT'
  | 'VIEW'
  | 'RETRY'
  | 'ROLE_ASSIGN'
  | 'ROLE_REMOVE'
  | 'RIDER_ASSIGN'
  | 'RIDER_UNASSIGN'
  | 'PROOF_OF_DELIVERY'
  | 'MFA_ENABLE'
  | 'MFA_RECOVERY_CODE_USED'
  | 'STEP_UP'
  | 'EXPORT';

export interface AuditEntry {
  entity: string;
  entityId: string;
  action: AuditAction;
  userId?: string;
  details?: Prisma.InputJsonValue;
}

type AuditFieldChanges = Record<string, { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }>;

function toAuditValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** The `fields` that differ between `before` and `after`, as JSON-safe from/to pairs (Decimal and Date become strings). */
export function fieldChanges<T extends object>(before: T, after: T, fields: readonly (keyof T)[]): AuditFieldChanges {
  const changes: AuditFieldChanges = {};
  for (const field of fields) {
    const from = toAuditValue(before[field]);
    const to = toAuditValue(after[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[String(field)] = { from, to };
  }
  return changes;
}

/** The given `fields` of `record` as JSON-safe values, for the before/after image of a create or delete. */
export function fieldValues<T extends object>(
  record: T,
  fields: readonly (keyof T)[],
): Record<string, Prisma.InputJsonValue | null> {
  return Object.fromEntries(fields.map((field) => [String(field), toAuditValue(record[field])]));
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists an audit log entry. Pass the caller's transaction client so the entry commits or rolls back with the
   * change it describes.
   */
  async log(entry: AuditEntry, client: Prisma.TransactionClient = this.prisma): Promise<void> {
    await client.auditLog.create({
      data: {
        entity: entry.entity,
        entityId: entry.entityId,
        action: entry.action,
        userId: entry.userId ?? null,
        details: entry.details ?? Prisma.JsonNull,
      },
    });
  }

  /**
   * Runs `change` and writes the audit entry built from its result in one transaction, so a committed change always
   * has its audit row and a failed audit write rolls the change back.
   */
  async record<T>(change: (tx: Prisma.TransactionClient) => Promise<T>, entry: (result: T) => AuditEntry): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await change(tx);
      await this.log(entry(result), tx);
      return result;
    });
  }
}
