import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovement, StockMovementReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RestockVariantInput } from './dto/restock.input';
import { AdjustVariantStockInput } from './dto/adjust-stock.input';
import { AuditService } from '../commons/audit.service';
import { StockLedgerService } from './stock-ledger.service';
import { MovementFilter, StockLedgerRepository } from './stock-ledger.repository';
import { manualAdjustmentError } from './stock-adjustment';
import { SerialUnitsService } from './serials/serial-units.service';

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
    private readonly serialUnits: SerialUnitsService,
  ) {}

  /**
   * Adds stock to a variant as a RECEIPT, or as a RETURN_RESTOCK when it is goods from a return request, with an
   * audit entry in the same transaction. Returned goods go back to the location their order was fulfilled from unless
   * a location is given. A variant whose product tracks serials needs one serial per unit: new ones for a receipt,
   * units sold on the return's order for a return (SerialUnitsService).
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
      const change = {
        variantId: input.variantId,
        quantity: input.quantity,
        serials: input.serials,
        source: {
          movementId: movement.id,
          actorId,
          refType: movement.refType ?? undefined,
          refId: movement.refId ?? undefined,
        },
      };
      const serials = input.returnRequestId
        ? await this.serialUnits.restockReturned(tx, change, input.returnRequestId, movement.locationId)
        : await this.serialUnits.receive(tx, change, movement.locationId);
      await this.auditStockChange(tx, movement, serials);
      return movement;
    });
  }

  /**
   * Moves a variant's on-hand stock at a location (default: the store's default location) by a signed delta, as one
   * ADJUSTMENT with its reason. Units reserved for open orders cannot be adjusted away. A serial-tracked variant names
   * its units: those removed (IN_STOCK there, then WRITTEN_OFF), or those added (new, or WRITTEN_OFF ones found).
   * @throws BadRequestException for a reason/direction mismatch, OTHER without a note, or too few units available;
   * NotFoundException if the variant or an active location does not exist.
   */
  async adjustVariantStock(input: AdjustVariantStockInput, actorId: string): Promise<StockMovement> {
    const refusal = manualAdjustmentError(input);
    if (refusal) throw new BadRequestException(refusal);
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      const locationId = await this.resolveLocation(tx, input.locationId);
      const movement = await this.ledger.adjustAt(tx, input.variantId, locationId, input.delta, {
        actorId,
        adjustmentReason: input.reason,
        note: input.note?.trim() || undefined,
      });
      if (!movement) {
        const available = await this.ledger.availableAt(tx, input.variantId, locationId);
        throw new BadRequestException(
          `Cannot remove ${-input.delta} units from variant "${input.variantId}": only ${available} available`,
        );
      }
      const change = {
        variantId: input.variantId,
        quantity: Math.abs(input.delta),
        serials: input.serials,
        source: { movementId: movement.id, actorId, note: movement.note ?? undefined },
      };
      const serials =
        input.delta < 0
          ? await this.serialUnits.writeOff(tx, change, locationId)
          : await this.serialUnits.receive(tx, change, locationId, { readmitWrittenOff: true });
      await this.auditStockChange(tx, movement, serials);
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

  private async resolveLocation(tx: Prisma.TransactionClient, locationId: string | undefined): Promise<string> {
    if (!locationId) return this.repository.defaultLocationId(tx);
    const location = await this.repository.findActiveLocation(tx, locationId);
    if (!location) throw new NotFoundException(`Stock location "${locationId}" not found or inactive`);
    return location.id;
  }

  private async auditStockChange(
    tx: Prisma.TransactionClient,
    movement: StockMovement,
    serials: string[],
  ): Promise<void> {
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
          ...(movement.adjustmentReason && { adjustmentReason: movement.adjustmentReason }),
          ...(movement.refType && { refType: movement.refType, refId: movement.refId }),
          ...(serials.length > 0 && { serials }),
        },
      },
      tx,
    );
  }
}
