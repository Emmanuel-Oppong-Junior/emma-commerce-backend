import { Injectable } from '@nestjs/common';
import { Prisma, ReturnRequest, ReturnStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReturnsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { orderId: string; userId: string; reason: string }): Promise<ReturnRequest> {
    return this.prisma.returnRequest.create({ data });
  }

  async findById(id: string): Promise<ReturnRequest | null> {
    return this.prisma.returnRequest.findUnique({ where: { id } });
  }

  async findByOrder(orderId: string): Promise<ReturnRequest[]> {
    return this.prisma.returnRequest.findMany({ where: { orderId } });
  }

  async findByUser(userId: string): Promise<ReturnRequest[]> {
    return this.prisma.returnRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(): Promise<ReturnRequest[]> {
    return this.prisma.returnRequest.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** Moves the request from `from` to `to` only if it is still `from`; null when another request changed it first. */
  async transitionStatus(
    id: string,
    from: ReturnStatus,
    to: ReturnStatus,
    changes: { refundAmount?: number; adminNote?: string },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ReturnRequest | null> {
    const { count } = await db.returnRequest.updateMany({
      where: { id, status: from },
      data: { ...changes, status: to },
    });
    return count === 0 ? null : db.returnRequest.findUniqueOrThrow({ where: { id } });
  }
}
