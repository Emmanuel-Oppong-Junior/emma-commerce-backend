import { Injectable } from '@nestjs/common';
import { InventoryAction, InventoryLog, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateLogData {
  productId: string;
  variantId?: string;
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

  async incrementProductStock(productId: string, quantity: number): Promise<{ quantity: number }> {
    const result = await this.prisma.product.update({
      where: { id: productId },
      data: { quantity: { increment: quantity } },
      select: { quantity: true },
    });
    return result;
  }

  async incrementVariantStock(variantId: string, quantity: number): Promise<{ quantity: number }> {
    const result = await this.prisma.variant.update({
      where: { id: variantId },
      data: { quantity: { increment: quantity } },
      select: { quantity: true },
    });
    return result;
  }

  async findLowStockProducts(
    threshold?: number,
  ): Promise<{ id: string; name: string; quantity: number; lowStockAlert: number | null }[]> {
    return this.prisma.$queryRaw`
      SELECT id, name, quantity, "lowStockAlert"
      FROM "Product"
      WHERE quantity <= COALESCE("lowStockAlert", ${threshold ?? 5})
        AND "isActive" = true
    `;
  }

  async findLowStockVariants(
    threshold?: number,
  ): Promise<{ id: string; productId: string; quantity: number; lowStockThreshold: number | null }[]> {
    return this.prisma.$queryRaw`
      SELECT id, "productId", quantity, "lowStockThreshold"
      FROM "Variant"
      WHERE quantity <= COALESCE("lowStockThreshold", ${threshold ?? 5})
    `;
  }
}
