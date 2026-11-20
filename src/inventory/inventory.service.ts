import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InventoryLog, Prisma } from '../generated/prisma/client';
import { InventoryRepository, CreateLogData } from './inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { RestockVariantInput } from './dto/restock.input';
import { AdjustVariantStockInput } from './dto/adjust-stock.input';
import { AuditService } from '../commons/audit.service';

/** Stock lives on the variant (the SKU); every change goes through here or the order transactions, and is logged. */
@Injectable()
export class InventoryService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Increments a variant's stock and records a RESTOCK log entry and an audit entry in the same transaction.
   * @throws NotFoundException if the variant does not exist.
   */
  async restockVariant(input: RestockVariantInput, actorId: string): Promise<InventoryLog> {
    const variant = await this.prisma.variant.findUnique({
      where: { id: input.variantId },
      select: { id: true, productId: true },
    });
    if (!variant) throw new NotFoundException(`Variant "${input.variantId}" not found`);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.variant.update({
        where: { id: input.variantId },
        data: { quantity: { increment: input.quantity } },
        select: { quantity: true },
      });
      const log = await this.inventoryRepository.createLog(tx, {
        productId: variant.productId,
        variantId: input.variantId,
        action: 'RESTOCK',
        quantityChange: input.quantity,
        quantityAfter: updated.quantity,
        reason: input.reason ?? 'Manual restock',
        actorId,
      });
      await this.auditStockChange(tx, log);
      return log;
    });
  }

  /**
   * Moves a variant's stock by a signed delta with a reason, never below zero, and logs an ADJUSTMENT.
   * @throws NotFoundException if the variant does not exist; BadRequestException if stock would go negative.
   */
  async adjustVariantStock(input: AdjustVariantStockInput, actorId: string): Promise<InventoryLog> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.variant.updateMany({
        where: { id: input.variantId, quantity: { gte: Math.max(0, -input.delta) } },
        data: { quantity: { increment: input.delta } },
      });
      const variant = await tx.variant.findUnique({
        where: { id: input.variantId },
        select: { quantity: true, productId: true },
      });
      if (!variant) throw new NotFoundException(`Variant "${input.variantId}" not found`);
      if (count === 0) {
        throw new BadRequestException(
          `Cannot remove ${-input.delta} units from variant "${input.variantId}": only ${variant.quantity} in stock`,
        );
      }
      const log = await this.inventoryRepository.createLog(tx, {
        productId: variant.productId,
        variantId: input.variantId,
        action: 'ADJUSTMENT',
        quantityChange: input.delta,
        quantityAfter: variant.quantity,
        reason: input.reason,
        actorId,
      });
      await this.auditStockChange(tx, log);
      return log;
    });
  }

  private async auditStockChange(tx: Prisma.TransactionClient, log: InventoryLog): Promise<void> {
    await this.auditService.log(
      {
        entity: 'Variant',
        entityId: log.variantId,
        action: 'STOCK_ADJUSTMENT',
        userId: log.actorId ?? undefined,
        details: {
          inventoryLogId: log.id,
          kind: log.action,
          productId: log.productId,
          quantityChange: log.quantityChange,
          quantityAfter: log.quantityAfter,
          reason: log.reason,
        },
      },
      tx,
    );
  }

  /**
   * Writes a single inventory change log entry within an existing database transaction.
   * Intended for use by order and return workflows that run inside their own transactions.
   */
  async logInventoryChange(tx: Prisma.TransactionClient, data: CreateLogData): Promise<void> {
    await this.inventoryRepository.createLog(tx, data);
  }

  async getAllLogs(): Promise<InventoryLog[]> {
    return this.inventoryRepository.findAll();
  }

  /** Inventory log entries of every variant of a product, most recent first. */
  async getProductLogs(productId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByProduct(productId);
  }

  /** Inventory log entries of one variant, most recent first. */
  async getVariantLogs(variantId: string): Promise<InventoryLog[]> {
    return this.inventoryRepository.findByVariant(variantId);
  }
}
