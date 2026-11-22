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
import { LotQuantity } from './lots/lots';

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
  ) {}

  /**
   * Adds stock to a variant as a RECEIPT, or as a RETURN_RESTOCK when it is goods from a return request, with an
   * audit entry in the same transaction. Returned goods go back to the location their order was fulfilled from unless
   * a location is given. A lot-tracked variant's receipt goes into the lot given (lot number and expiry required);
   * returned units go into the lot named or, by default, the lots the order's sale drew them from (P4-C.1). Returns
   * the first movement when the units spread over several lots.
   * @throws NotFoundException if the variant, the return request or the location does not exist; BadRequestException
   *   for a missing, invalid or unexpected lot.
   */
  async restockVariant(input: RestockVariantInput, actorId: string): Promise<StockMovement> {
    return this.prisma.$transaction(async (tx) => {
      await this.ensureVariant(tx, input.variantId);
      let locationId = input.locationId && (await this.ensureLocation(tx, input.locationId));
      let orderId: string | undefined;
      if (input.returnRequestId) {
        const returned = await this.repository.findReturnRequestLocation(tx, input.returnRequestId);
        if (!returned) throw new NotFoundException(`Return request "${input.returnRequestId}" not found`);
        locationId ||= returned.stockLocationId ?? undefined;
        orderId = returned.orderId;
      }
      const reason = input.returnRequestId ? StockMovementReason.RETURN_RESTOCK : StockMovementReason.RECEIPT;
      const source = {
        actorId,
        note: input.reason ?? (input.returnRequestId ? 'Returned goods restocked' : 'Manual restock'),
        ...(input.returnRequestId && { refType: 'ReturnRequest', refId: input.returnRequestId }),
      };
      const lots = await this.restockLots(tx, input, orderId);
      const movements = lots
        ? await this.ledger.receiveLots(
            tx,
            input.variantId,
            input.quantity,
            reason,
            source,
            locationId || undefined,
            lots,
          )
        : [await this.ledger.receive(tx, input.variantId, input.quantity, reason, source, locationId || undefined)];
      await this.auditStockChange(tx, movements);
      return movements[0];
    });
  }

  /** The lots a restock goes into: none for an untracked variant. */
  private async restockLots(
    tx: Prisma.TransactionClient,
    input: RestockVariantInput,
    orderId: string | undefined,
  ): Promise<LotQuantity[] | undefined> {
    if (!(await this.lots.isTracked(tx, input.variantId))) {
      if (input.lot)
        throw new BadRequestException(`Variant "${input.variantId}" does not track lots; leave the lot out`);
      return undefined;
    }
    const now = new Date();
    if (!orderId) {
      if (!input.lot) {
        throw new BadRequestException(
          `Variant "${input.variantId}" tracks lots: give the lot number and expiry of the units received`,
        );
      }
      const lot = await this.lots.resolveLot(tx, input.variantId, input.lot, now, true);
      return [{ lotId: lot.id, quantity: input.quantity }];
    }
    if (input.lot) {
      const lot = await this.lots.existingLot(tx, input.variantId, input.lot, now);
      return [{ lotId: lot.id, quantity: input.quantity }];
    }
    return this.lots.returnLots(tx, orderId, input.variantId, input.quantity, now);
  }

  /**
   * Moves a variant's on-hand stock at a location (default: the store's default location) by a signed delta, as one
   * ADJUSTMENT with its reason. Units reserved for open orders cannot be adjusted away. A lot-tracked variant adds to
   * the lot given (an existing one, or a new one with its expiry) and removes from the lot given or, without one,
   * first expiry first out, one movement per lot (the first is returned).
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
      await this.auditStockChange(tx, movements);
      return movements[0];
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

  private async auditStockChange(tx: Prisma.TransactionClient, movements: StockMovement[]): Promise<void> {
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
        },
      },
      tx,
    );
  }
}
