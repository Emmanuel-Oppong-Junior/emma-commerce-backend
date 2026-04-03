import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'RESTORE' | 'STATUS_CHANGE';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists an audit log entry for a create, update, delete, or status-change action on an entity.
   * @param params.entity - The name of the entity being audited (e.g., "Order").
   * @param params.entityId - The ID of the entity being audited.
   * @param params.action - The type of action performed.
   * @param params.userId - Optional ID of the user who performed the action.
   * @param params.details - Optional additional context to store with the log entry.
   */
  async log(params: {
    entity: string;
    entityId: string;
    action: AuditAction;
    userId?: string;
    details?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        entity: params.entity,
        entityId: params.entityId,
        action: params.action,
        userId: params.userId ?? null,
        details: params.details ?? Prisma.JsonNull,
      },
    });
  }
}
