import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovement, StockMovementReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RestockVariantInput } from './dto/restock.input';
import { AdjustVariantStockInput } from './dto/adjust-stock.input';
import { AuditService } from '../commons/audit.service';
import { StockLedgerService } from './stock-ledger.service';
import { MovementFilter, StockLedgerRepository } from './stock-ledger.repository';

export interface StockMovementPage {
  nodes: StockMovement[];
  totalCount: number;
  hasNextPage: boolean;
}

const MAX_PAGE_SIZE = 100;

/** Admin stock operations. Every change goes through the ledger (StockLedgerService) and is audited. */
@Injectable()
export class InventoryService {
  constructor(
    private readonly ledger: StockLedgerService,
    private readonly repository: StockLedgerRepository,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Adds stock to a variant as a RECEIPT, or as a RETURN_RESTOCK when it is goods from a return request, with an
   * audit entry in the same transaction. Returned goods go back to the location their order was fulfilled from unless
   * a location is given.
   * @throws NotFoundException if the variant, the return request or the location does not exist.
   */
  async restockVariant(input: RestockVariantInput, actorId: string): Promise<StockMovement> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      let locationId = input.locationId && (await this.ensureLocation(tx, input.locationId));
      if (input.returnRequestId) {
        const returned = await this.repository.findReturnRequestLocation(tx, input.returnRequestId);
        if (!returned) throw new NotFoundException(`Return request "${input.returnRequestId}" not found`);
        locationId ||= returned.stockLocationId ?? undefined;
      }
      const movement = await this.ledger.receive(
        tx,
        input.variantId,
        input.quantity,
        input.returnRequestId ? StockMovementReason.RETURN_RESTOCK : StockMovementReason.RECEIPT,
        {
          actorId,
          note: input.reason ?? (input.returnRequestId ? 'Returned goods restocked' : 'Manual restock'),
          ...(input.returnRequestId && { refType: 'ReturnRequest', refId: input.returnRequestId }),
        },
        locationId || undefined,
      );
      await this.auditStockChange(tx, movement);
      return movement;
    });
  }

  /**
   * Moves a variant's on-hand stock by a signed delta with a reason, as an ADJUSTMENT. Units reserved for open orders
   * cannot be adjusted away.
   * @throws NotFoundException if the variant does not exist; BadRequestException if too few units are available.
   */
  async adjustVariantStock(input: AdjustVariantStockInput, actorId: string): Promise<StockMovement> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      const locationId = input.locationId && (await this.ensureLocation(tx, input.locationId));
      const movement = await this.ledger.adjust(
        tx,
        input.variantId,
        input.delta,
        { actorId, note: input.reason },
        locationId || undefined,
      );
      if (!movement) {
        const available = await this.ledger.available(tx, input.variantId, locationId || undefined);
        throw new BadRequestException(
          `Cannot remove ${-input.delta} units from variant "${input.variantId}": only ${available} available`,
        );
      }
      await this.auditStockChange(tx, movement);
      return movement;
    });
  }

  /** Ledger entries, newest first, paginated by movement id (at most 100 per page). */
  async getMovements(filter: MovementFilter, first: number, after?: string): Promise<StockMovementPage> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.findMovements(filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  private async ensureVariant(tx: Prisma.TransactionClient, variantId: string): Promise<void> {
    const exists = await tx.variant.count({ where: { id: variantId } });
    if (!exists) throw new NotFoundException(`Variant "${variantId}" not found`);
  }

  private async ensureLocation(tx: Prisma.TransactionClient, locationId: string): Promise<string> {
    const exists = await tx.stockLocation.count({ where: { id: locationId } });
    if (!exists) throw new NotFoundException(`Stock location "${locationId}" not found`);
    return locationId;
  }

  private async auditStockChange(tx: Prisma.TransactionClient, movement: StockMovement): Promise<void> {
    await this.auditService.log(
      {
        entity: 'Variant',
        entityId: movement.variantId,
        action: 'STOCK_ADJUSTMENT',
        userId: movement.actorId ?? undefined,
        details: {
          stockMovementId: movement.id,
          kind: movement.reason,
          locationId: movement.locationId,
          onHandDelta: movement.onHandDelta,
          reason: movement.note,
          ...(movement.refType && { refType: movement.refType, refId: movement.refId }),
        },
      },
      tx,
    );
  }
}
