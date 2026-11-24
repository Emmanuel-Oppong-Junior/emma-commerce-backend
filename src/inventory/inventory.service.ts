import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovement, StockMovementReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RestockVariantInput } from './dto/restock.input';
import { AdjustVariantStockInput } from './dto/adjust-stock.input';
import { AuditService } from '../commons/audit.service';
import { StockLedgerService } from './stock-ledger.service';
import { MovementFilter, StockLedgerRepository } from './stock-ledger.repository';
import { manualAdjustmentError } from './stock-adjustment';
import { LotsService } from './lots/lots.service';
import { LotQuantity, LotSpec } from './lots/lots';
import { SerialUnitsService } from './serials/serial-units.service';

export interface ReturnRestock {
  variantId: string;
  quantity: number;
  returnRequestId: string;
  orderId: string;
  locationId?: string;
  lot?: LotSpec;
  serials?: string[];
  note: string;
}

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
    private readonly lots: LotsService,
    private readonly serialUnits: SerialUnitsService,
  ) {}

  /**
   * Adds stock to a variant as a RECEIPT, or as a RETURN_RESTOCK when it is goods from a legacy whole-order return
   * request (an item-level return's units are restocked by its inspection, ReturnsService.inspectReturn), with an
   * audit entry in the same transaction. Returned goods go back to the location their order was fulfilled from unless
   * a location is given. A lot-tracked variant's receipt goes into the lot given (lot number and expiry required);
   * returned units go into the lot named or, by default, the lots the order's sale drew them from (P4-C.1). Returns
   * the first movement when the units spread over several lots. A variant whose product tracks serials needs one
   * serial per unit: new ones for a receipt, units sold on the return's order for a return (SerialUnitsService).
   * @throws NotFoundException if the variant, the return request or the location does not exist; BadRequestException
   *   for a missing, invalid or unexpected lot, or an item-level return request.
   */
  async restockVariant(input: RestockVariantInput, actorId: string): Promise<StockMovement> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      const locationId = input.locationId && (await this.ensureLocation(tx, input.locationId));
      let restocked: { movements: StockMovement[]; serials: string[] };
      if (input.returnRequestId) {
        const returned = await this.repository.findReturnRequestLocation(tx, input.returnRequestId);
        if (!returned) throw new NotFoundException(`Return request "${input.returnRequestId}" not found`);
        if (returned.lineCount > 0) {
          throw new BadRequestException(
            `Return request "${input.returnRequestId}" is an item-level return: its units are restocked when it is inspected (inspectReturn)`,
          );
        }
        restocked = await this.restockReturn(
          tx,
          {
            variantId: input.variantId,
            quantity: input.quantity,
            returnRequestId: input.returnRequestId,
            orderId: returned.orderId,
            locationId: locationId || returned.stockLocationId || undefined,
            lot: input.lot,
            serials: input.serials,
            note: input.reason ?? 'Returned goods restocked',
          },
          actorId,
        );
      } else {
        restocked = await this.receiveStock(tx, input, locationId || undefined, actorId);
      }
      await this.auditStockChange(tx, restocked.movements, restocked.serials);
      return restocked.movements[0];
    });
  }

  /**
   * Puts returned units of an order back into sellable stock at `locationId` (default: the store's default location)
   * as RETURN_RESTOCK movements referring to the return request, on the caller's transaction; the caller audits. A
   * lot-tracked variant's units go into the lot named or the lots the order's sale drew them from; a serial-tracked
   * variant names one unit SOLD on that order per unit.
   */
  async restockReturn(
    tx: Prisma.TransactionClient,
    restock: ReturnRestock,
    actorId: string,
  ): Promise<{ movements: StockMovement[]; serials: string[] }> {
    const reason = StockMovementReason.RETURN_RESTOCK;
    const source = { actorId, note: restock.note, refType: 'ReturnRequest', refId: restock.returnRequestId };
    const lots = await this.returnLots(tx, restock);
    const movements = lots
      ? await this.ledger.receiveLots(tx, restock.variantId, restock.quantity, reason, source, restock.locationId, lots)
      : [await this.ledger.receive(tx, restock.variantId, restock.quantity, reason, source, restock.locationId)];
    const [movement] = movements;
    const serials = await this.serialUnits.restockReturned(
      tx,
      {
        variantId: restock.variantId,
        quantity: restock.quantity,
        serials: restock.serials,
        source: { movementId: movement.id, actorId, refType: 'ReturnRequest', refId: restock.returnRequestId },
      },
      restock.returnRequestId,
      movement.locationId,
    );
    return { movements, serials };
  }

  private async receiveStock(
    tx: Prisma.TransactionClient,
    input: RestockVariantInput,
    locationId: string | undefined,
    actorId: string,
  ): Promise<{ movements: StockMovement[]; serials: string[] }> {
    const reason = StockMovementReason.RECEIPT;
    const source = { actorId, note: input.reason ?? 'Manual restock' };
    const lots = await this.receiptLots(tx, input);
    const movements = lots
      ? await this.ledger.receiveLots(tx, input.variantId, input.quantity, reason, source, locationId, lots)
      : [await this.ledger.receive(tx, input.variantId, input.quantity, reason, source, locationId)];
    const [movement] = movements;
    const serials = await this.serialUnits.receive(
      tx,
      {
        variantId: input.variantId,
        quantity: input.quantity,
        serials: input.serials,
        source: { movementId: movement.id, actorId },
      },
      movement.locationId,
    );
    return { movements, serials };
  }

  /** The lots a receipt goes into: none for an untracked variant. */
  private async receiptLots(
    tx: Prisma.TransactionClient,
    input: RestockVariantInput,
  ): Promise<LotQuantity[] | undefined> {
    if (!(await this.lots.isTracked(tx, input.variantId))) {
      if (input.lot)
        throw new BadRequestException(`Variant "${input.variantId}" does not track lots; leave the lot out`);
      return undefined;
    }
    if (!input.lot) {
      throw new BadRequestException(
        `Variant "${input.variantId}" tracks lots: give the lot number and expiry of the units received`,
      );
    }
    const lot = await this.lots.resolveLot(tx, input.variantId, input.lot, new Date(), true);
    return [{ lotId: lot.id, quantity: input.quantity }];
  }

  /** The lots returned units go into: none for an untracked variant. */
  private async returnLots(tx: Prisma.TransactionClient, restock: ReturnRestock): Promise<LotQuantity[] | undefined> {
    if (!(await this.lots.isTracked(tx, restock.variantId))) {
      if (restock.lot)
        throw new BadRequestException(`Variant "${restock.variantId}" does not track lots; leave the lot out`);
      return undefined;
    }
    const now = new Date();
    if (restock.lot) {
      const lot = await this.lots.existingLot(tx, restock.variantId, restock.lot, now);
      return [{ lotId: lot.id, quantity: restock.quantity }];
    }
    return this.lots.returnLots(tx, restock.orderId, restock.variantId, restock.quantity, now);
  }

  /**
   * Moves a variant's on-hand stock at a location (default: the store's default location) by a signed delta, as one
   * ADJUSTMENT with its reason. Units reserved for open orders cannot be adjusted away. A lot-tracked variant adds to
   * the lot given (an existing one, or a new one with its expiry) and removes from the lot given or, without one,
   * first expiry first out, one movement per lot (the first is returned). A serial-tracked variant names its units:
   * those removed (IN_STOCK there, then WRITTEN_OFF), or those added (new, or WRITTEN_OFF ones found).
   * @throws BadRequestException for a reason/direction mismatch, OTHER without a note, too few units available, or a
   * missing, invalid or unexpected lot; NotFoundException if the variant or an active location does not exist.
   */
  async adjustVariantStock(input: AdjustVariantStockInput, actorId: string): Promise<StockMovement> {
    const refusal = manualAdjustmentError(input);
    if (refusal) throw new BadRequestException(refusal);
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      const locationId = await this.resolveLocation(tx, input.locationId);
      const source = { actorId, adjustmentReason: input.reason, note: input.note?.trim() || undefined };
      const lots = await this.adjustmentLots(tx, input, locationId);
      let movements: StockMovement[] | null;
      if (lots === null) {
        const movement = await this.ledger.adjustAt(tx, input.variantId, locationId, input.delta, source);
        movements = movement && [movement];
      } else {
        movements = await this.ledger.adjustLots(tx, input.variantId, locationId, input.delta, source, lots);
      }
      if (!movements) {
        const available = await this.ledger.availableAt(tx, input.variantId, locationId);
        throw new BadRequestException(
          `Cannot remove ${-input.delta} units from variant "${input.variantId}": only ${available} available`,
        );
      }
      const [movement] = movements;
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
      await this.auditStockChange(tx, movements, serials);
      return movement;
    });
  }

  /**
   * The lots an adjustment names: null for an untracked variant, undefined for a tracked removal by FEFO.
   * @throws BadRequestException for a lot on an untracked variant, an addition without a lot, or a named lot holding
   *   too few units at the location.
   */
  private async adjustmentLots(
    tx: Prisma.TransactionClient,
    input: AdjustVariantStockInput,
    locationId: string,
  ): Promise<LotQuantity[] | undefined | null> {
    if (!(await this.lots.isTracked(tx, input.variantId))) {
      if (input.lot)
        throw new BadRequestException(`Variant "${input.variantId}" does not track lots; leave the lot out`);
      return null;
    }
    const now = new Date();
    if (input.delta > 0) {
      if (!input.lot) {
        throw new BadRequestException(`Variant "${input.variantId}" tracks lots: name the lot the units are added to`);
      }
      const lot = await this.lots.resolveLot(tx, input.variantId, input.lot, now, false);
      return [{ lotId: lot.id, quantity: input.delta }];
    }
    if (!input.lot) return undefined;
    const lot = await this.lots.lotToRemoveFrom(tx, input.variantId, input.lot);
    const held = await this.lots.lotOnHandAt(tx, lot.id, locationId);
    if (held < -input.delta) {
      throw new BadRequestException(
        `Cannot remove ${-input.delta} units of lot "${lot.lotNumber}": only ${held} at this location`,
      );
    }
    return [{ lotId: lot.id, quantity: -input.delta }];
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
    movements: StockMovement[],
    serials: string[],
  ): Promise<void> {
    const [movement] = movements;
    const lotMovements = movements.filter((m) => m.lotId);
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
          onHandDelta: movements.reduce((sum, m) => sum + m.onHandDelta, 0),
          reason: movement.note,
          ...(movement.adjustmentReason && { adjustmentReason: movement.adjustmentReason }),
          ...(movement.refType && { refType: movement.refType, refId: movement.refId }),
          ...(lotMovements.length > 0 && {
            lots: lotMovements.map((m) => ({ lotId: m.lotId, onHandDelta: m.onHandDelta, stockMovementId: m.id })),
          }),
          ...(serials.length > 0 && { serials }),
        },
      },
      tx,
    );
  }
}
