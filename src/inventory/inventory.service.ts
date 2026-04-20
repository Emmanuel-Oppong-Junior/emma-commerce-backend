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

  /**
   * Increments a product's stock quantity and records a restock inventory log entry.
   * @param input - Restock data containing the product ID, quantity to add, and an optional reason.
   * @param actorId - The ID of the admin or system user performing the restock.
   * @returns The created inventory log entry.
   * @throws NotFoundException if the product does not exist.
   */
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

  /**
   * Increments a variant's stock quantity and records a restock inventory log entry.
   * @param input - Restock data containing the variant ID, quantity to add, and an optional reason.
   * @param actorId - The ID of the admin or system user performing the restock.
   * @returns The created inventory log entry.
   * @throws NotFoundException if the variant does not exist.
   */
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

  /**
   * Writes a single inventory change log entry within an existing database transaction.
   * Intended for use by order and return workflows that run inside their own transactions.
   * @param tx - The active Prisma transaction client.
   * @param data - Log entry data including product ID, action type, quantity change, and reason.
   */
  async logInventoryChange(tx: Prisma.TransactionClient, data: CreateLogData): Promise<void> {
    await this.inventoryRepository.createLog(tx, data);
  }

  /**
   * Retrieves all inventory log entries for a product, ordered by most recent first.
   * @param productId - The ID of the product.
   * @returns List of inventory log entries for the product.
   */
  async getAllLogs(): Promise<InventoryLog[]> {
    return this.inventoryRepository.findAll();
  }

  async getProductLogs(productId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByProduct(productId);
  }

  /**
   * Retrieves all inventory log entries for a specific variant, ordered by most recent first.
   * @param variantId - The ID of the variant.
   * @returns List of inventory log entries for the variant.
   */
  async getVariantLogs(variantId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByVariant(variantId);
  }
}
