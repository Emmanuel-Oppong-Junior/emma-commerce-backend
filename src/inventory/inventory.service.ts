import { Injectable, NotFoundException } from '@nestjs/common';
import { InventoryLog, Prisma } from '@prisma/client';
import { InventoryRepository, CreateLogData } from './inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { RestockProductInput, RestockVariantInput } from './dto/restock.input';

@Injectable()
export class InventoryService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly prisma: PrismaService,
  ) {}

  async restockProduct(input: RestockProductInput, actorId: string): Promise<InventoryLog> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, quantity: true },
    });
    if (!product) throw new NotFoundException(`Product "${input.productId}" not found`);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: input.productId },
        data: { quantity: { increment: input.quantity }, stockStatus: 'IN_STOCK' },
        select: { quantity: true },
      });
      return this.inventoryRepository.createLog(tx, {
        productId: input.productId,
        action: 'RESTOCK',
        quantityChange: input.quantity,
        quantityAfter: updated.quantity,
        reason: input.reason ?? 'Manual restock',
        actorId,
      });
    });
  }

  async restockVariant(input: RestockVariantInput, actorId: string): Promise<InventoryLog> {
    const variant = await this.prisma.variant.findUnique({
      where: { id: input.variantId },
      select: { id: true, quantity: true, productId: true },
    });
    if (!variant) throw new NotFoundException(`Variant "${input.variantId}" not found`);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.variant.update({
        where: { id: input.variantId },
        data: { quantity: { increment: input.quantity } },
        select: { quantity: true },
      });
      return this.inventoryRepository.createLog(tx, {
        productId: variant.productId,
        variantId: input.variantId,
        action: 'RESTOCK',
        quantityChange: input.quantity,
        quantityAfter: updated.quantity,
        reason: input.reason ?? 'Manual restock',
        actorId,
      });
    });
  }

  async logInventoryChange(tx: Prisma.TransactionClient, data: CreateLogData): Promise<void> {
    await this.inventoryRepository.createLog(tx, data);
  }

  async getProductLogs(productId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByProduct(productId);
  }

  async getVariantLogs(variantId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByVariant(variantId);
  }
}
