import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReturnRequest, ReturnStatus } from '@prisma/client';
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

  async updateStatus(
    id: string,
    status: ReturnStatus,
    refundAmount?: number,
    adminNote?: string,
  ): Promise<ReturnRequest> {
    try {
      return await this.prisma.returnRequest.update({
        where: { id },
        data: { status, refundAmount, adminNote },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Return request "${id}" not found`);
      }
      throw e;
    }
  }

  async restoreOrderStock(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { quantity: { increment: item.quantity } },
      });
    }
  }
}
