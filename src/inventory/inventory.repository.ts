import { Injectable } from '@nestjs/common';
import { InventoryAction, InventoryLog, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateLogData {
  productId: string;
  variantId: string;
  action: InventoryAction;
  quantityChange: number;
  quantityAfter: number;
  reason?: string;
  actorId?: string;
}

@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createLog(tx: Prisma.TransactionClient | PrismaService, data: CreateLogData): Promise<InventoryLog> {
    return (tx as PrismaService).inventoryLog.create({ data });
  }

  async findAll(): Promise<InventoryLog[]> {
    return this.prisma.inventoryLog.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByProduct(productId: string): Promise<InventoryLog[]> {
    return this.prisma.inventoryLog.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByVariant(variantId: string): Promise<InventoryLog[]> {
    return this.prisma.inventoryLog.findMany({
      where: { variantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Active variants of active products at or below their low-stock threshold (default 5 when unset). */
  async findLowStockVariants(
    threshold?: number,
  ): Promise<{ id: string; productId: string; sku: string; quantity: number; lowStockThreshold: number | null }[]> {
    return this.prisma.$queryRaw`
      SELECT v.id, v."productId", v.sku, v.quantity, v."lowStockThreshold"
      FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
      WHERE v."isActive" AND p."isActive" AND v.quantity <= COALESCE(v."lowStockThreshold", ${threshold ?? 5})
    `;
  }
}
