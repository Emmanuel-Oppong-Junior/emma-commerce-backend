import { Injectable } from '@nestjs/common';
import {
  Prisma,
  StockAdjustmentReason,
  StockMovement,
  StockMovementReason,
  StockReservationStatus,
} from '../generated/prisma/client';
import { OutboxService } from '../outbox/outbox.service';
import { StockLedgerRepository } from './stock-ledger.repository';
import { consumeEffect, crossesLowStock, releaseEffect, reserveEffect, StockEffect } from './stock';

type Tx = Prisma.TransactionClient;

export interface MovementSource {
  refType?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  adjustmentReason?: StockAdjustmentReason;
}

/**
 * Every stock change (ADR-0008): a conditional update of the StockLevel at the default location, one StockMovement
 * row and, when available stock falls to the variant's low-stock threshold, an `inventory.low_stock.v1` event, all on
 * the caller's transaction. Reservation transitions are conditional on the reservation's status, so repeating a
 * consume or release changes nothing.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly outbox: OutboxService,
  ) {}

  /** Adds stock (a delivery, opening stock, or returned goods with RETURN_RESTOCK). */
  async receive(
    tx: Tx,
    variantId: string,
    quantity: number,
    reason: StockMovementReason,
    source: MovementSource,
  ): Promise<StockMovement> {
    const locationId = await this.repository.defaultLocationId(tx);
    await this.repository.ensureLevel(tx, variantId, locationId);
    const movement = await this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: quantity, reservedDelta: 0, reason },
      source,
    );
    if (!movement) throw new Error(`Stock level of variant "${variantId}" refused a receipt of ${quantity}`);
    return movement;
  }

  /** Changes on-hand stock by a signed delta; null when that would take it below the units reserved for orders. */
  async adjust(tx: Tx, variantId: string, delta: number, source: MovementSource): Promise<StockMovement | null> {
    const locationId = await this.repository.defaultLocationId(tx);
    await this.repository.ensureLevel(tx, variantId, locationId);
    return this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: delta, reservedDelta: 0, reason: StockMovementReason.ADJUSTMENT },
      source,
    );
  }

  /**
   * Changes on-hand stock at `locationId` by a signed delta, as an ADJUSTMENT with its reason; null when that would
   * take it below the units reserved there.
   */
  async adjustAt(
    tx: Tx,
    variantId: string,
    locationId: string,
    delta: number,
    source: MovementSource & { adjustmentReason: StockAdjustmentReason },
  ): Promise<StockMovement | null> {
    await this.repository.ensureLevel(tx, variantId, locationId);
    return this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: delta, reservedDelta: 0, reason: StockMovementReason.ADJUSTMENT },
      source,
    );
  }

  /** Units of the variant that can still be sold or adjusted away at `locationId`. */
  async availableAt(tx: Tx, variantId: string, locationId: string): Promise<number> {
    const level = await this.repository.findLevel(tx, variantId, locationId);
    return level ? level.onHand - level.reserved : 0;
  }

  /** Units of the variant that can still be sold or adjusted away at the default location. */
  async available(tx: Tx, variantId: string): Promise<number> {
    const level = await this.repository.findLevel(tx, variantId, await this.repository.defaultLocationId(tx));
    return level ? level.onHand - level.reserved : 0;
  }

  /** Holds `quantity` units for an order line if that many are available; false (nothing written) otherwise. */
  async reserve(
    tx: Tx,
    line: { variantId: string; quantity: number; orderId: string; orderItemId: string; expiresAt: Date | null },
    actorId?: string,
  ): Promise<boolean> {
    const locationId = await this.repository.defaultLocationId(tx);
    const movement = await this.move(tx, line.variantId, locationId, reserveEffect(line.quantity), {
      refType: 'Order',
      refId: line.orderId,
      actorId,
    });
    if (!movement) return false;
    await this.repository.createReservation(tx, { ...line, locationId });
    return true;
  }

  /** The sale happened (online payment captured, or a cash-on-delivery order dispatched): ACTIVE -> CONSUMED. */
  async consumeOrder(tx: Tx, orderId: string, actorId?: string): Promise<number> {
    let consumed = 0;
    for (const reservation of await this.repository.findReservations(tx, orderId, [StockReservationStatus.ACTIVE])) {
      const claimed = await this.repository.claimReservation(
        tx,
        reservation.id,
        StockReservationStatus.ACTIVE,
        StockReservationStatus.CONSUMED,
      );
      if (!claimed) continue;
      await this.moveOrFail(tx, reservation, consumeEffect(reservation.quantity), {
        refType: 'Order',
        refId: orderId,
        actorId,
      });
      consumed += 1;
    }
    return consumed;
  }

  /** The order was cancelled or expired: every ACTIVE or CONSUMED reservation becomes RELEASED, exactly once. */
  async releaseOrder(tx: Tx, orderId: string, source: Omit<MovementSource, 'refType' | 'refId'>): Promise<number> {
    let released = 0;
    const open = [StockReservationStatus.ACTIVE, StockReservationStatus.CONSUMED];
    for (const reservation of await this.repository.findReservations(tx, orderId, open)) {
      for (const from of open) {
        const claimed = await this.repository.claimReservation(
          tx,
          reservation.id,
          from,
          StockReservationStatus.RELEASED,
        );
        if (!claimed) continue;
        await this.moveOrFail(tx, reservation, releaseEffect(from, reservation.quantity)!, {
          ...source,
          refType: 'Order',
          refId: orderId,
        });
        released += 1;
        break;
      }
    }
    return released;
  }

  private async moveOrFail(
    tx: Tx,
    reservation: { variantId: string; locationId: string; id: string },
    effect: StockEffect,
    source: MovementSource,
  ): Promise<void> {
    const movement = await this.move(tx, reservation.variantId, reservation.locationId, effect, source);
    // The level always covers its reservations (reserved <= onHand); a refusal means the ledger is corrupt.
    if (!movement) throw new Error(`Stock level refused the ${effect.reason} of reservation "${reservation.id}"`);
  }

  private async move(
    tx: Tx,
    variantId: string,
    locationId: string,
    effect: StockEffect,
    source: MovementSource,
  ): Promise<StockMovement | null> {
    const after = await this.repository.applyEffect(tx, variantId, locationId, effect);
    if (!after) return null;
    const movement = await this.repository.insertMovement(tx, { variantId, locationId, ...effect, ...source });
    const availableAfter = after.onHand - after.reserved;
    const availableBefore = availableAfter - effect.onHandDelta + effect.reservedDelta;
    if (availableAfter < availableBefore) {
      const variant = await this.repository.findVariantForAlert(tx, variantId);
      const threshold = variant?.lowStockThreshold ?? null;
      if (crossesLowStock(availableBefore, availableAfter, threshold)) {
        await this.outbox.record(tx, {
          type: 'inventory.low_stock.v1',
          aggregateId: variantId,
          payload: { variantId, locationId, available: availableAfter, movementId: movement.id },
        });
      }
    }
    return movement;
  }
}
