import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'RESTORE' | 'STATUS_CHANGE';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

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
