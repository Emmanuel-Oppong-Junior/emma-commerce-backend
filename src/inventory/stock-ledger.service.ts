import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  StockAdjustmentReason,
  StockMovement,
  StockMovementReason,
  StockReservationStatus,
} from '../generated/prisma/client';
import { LoggerService } from '../commons/logger.service';
import { OutboxService } from '../outbox/outbox.service';
import { StockLedgerRepository } from './stock-ledger.repository';
import {
  consumeEffect,
  crossesLowStock,
  releaseEffect,
  reserveEffect,
  StockEffect,
  transferInEffect,
  transferOutEffect,
} from './stock';
import { LotStockRepository } from './lots/lot-stock.repository';
import {
  allocateFromDrawn,
  DrawPolicy,
  expiredInDraw,
  expiredUnits,
  expiryWriteOff,
  fefoDraw,
  LotQuantity,
} from './lots/lots';

type Tx = Prisma.TransactionClient;

const CONTEXT = 'StockLedgerService';

export interface MovementSource {
  refType?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  adjustmentReason?: StockAdjustmentReason;
  /** What one unit cost: purchase-order receipts only (P4-E.1; a CHECK allows it on RECEIPT movements only) */
  unitCost?: Prisma.Decimal;
}

/**
 * Every stock change (ADR-0008): a conditional update of one StockLevel (the default location unless a location is
 * given), one StockMovement row and, when the variant's available stock summed over active locations falls to its
 * low-stock threshold, an `inventory.low_stock.v1` event, all on the caller's transaction. Reservation transitions are conditional on the reservation's status, so repeating a
 * consume or release changes nothing.
 *
 * Lots (P4-C.1): for a product with trackLots, every on-hand change also moves LotStock and writes one movement per
 * lot touched (the level is updated once for the total). Units added go into the lots the caller names; units taken
 * come from the lots named, else first-expiry-first-out (see DrawPolicy). Reservations stay per variant and location.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly repository: StockLedgerRepository,
    private readonly outbox: OutboxService,
    private readonly lots: LotStockRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Adds stock (a delivery, opening stock, or returned goods with RETURN_RESTOCK) at the location (default). A
   * lot-tracked variant needs `lots` (see receiveIntoLot); the first movement is returned.
   */
  async receive(
    tx: Tx,
    variantId: string,
    quantity: number,
    reason: StockMovementReason,
    source: MovementSource,
    locationId?: string,
    lots?: LotQuantity[],
  ): Promise<StockMovement> {
    const movements = await this.receiveLots(tx, variantId, quantity, reason, source, locationId, lots);
    return movements[0];
  }

  /** Like receive, returning every movement (one per lot for a lot-tracked variant). */
  async receiveLots(
    tx: Tx,
    variantId: string,
    quantity: number,
    reason: StockMovementReason,
    source: MovementSource,
    locationId?: string,
    lots?: LotQuantity[],
  ): Promise<StockMovement[]> {
    locationId ??= await this.repository.defaultLocationId(tx);
    await this.repository.ensureLevel(tx, variantId, locationId);
    const movements = await this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: quantity, reservedDelta: 0, reason },
      source,
      { lots },
    );
    if (!movements) throw new Error(`Stock level of variant "${variantId}" refused a receipt of ${quantity}`);
    return movements;
  }

  /** Changes on-hand stock by a signed delta; null when that would take it below the units reserved for orders. */
  async adjust(
    tx: Tx,
    variantId: string,
    delta: number,
    source: MovementSource,
    locationId?: string,
  ): Promise<StockMovement | null> {
    locationId ??= await this.repository.defaultLocationId(tx);
    await this.repository.ensureLevel(tx, variantId, locationId);
    const movements = await this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: delta, reservedDelta: 0, reason: StockMovementReason.ADJUSTMENT },
      source,
      { policy: DrawPolicy.Removal },
    );
    return movements?.[0] ?? null;
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
    return (await this.adjustLots(tx, variantId, locationId, delta, source))?.[0] ?? null;
  }

  /**
   * adjustAt for a lot-tracked variant, returning every movement: an increase goes into the lot named in `lots`
   * (required), a decrease comes from the lots named or, without them, first expiry first out. Null when the level or
   * a named lot holds too few units.
   */
  async adjustLots(
    tx: Tx,
    variantId: string,
    locationId: string,
    delta: number,
    source: MovementSource & { adjustmentReason: StockAdjustmentReason },
    lots?: LotQuantity[],
  ): Promise<StockMovement[] | null> {
    await this.repository.ensureLevel(tx, variantId, locationId);
    return this.move(
      tx,
      variantId,
      locationId,
      { onHandDelta: delta, reservedDelta: 0, reason: StockMovementReason.ADJUSTMENT },
      source,
      { lots, policy: DrawPolicy.Removal },
    );
  }

  /** Units of the variant that can still be sold or adjusted away at `locationId`. */
  async availableAt(tx: Tx, variantId: string, locationId: string): Promise<number> {
    const level = await this.repository.findLevel(tx, variantId, locationId);
    return level ? level.onHand - level.reserved : 0;
  }

  /**
   * Takes `quantity` units off the location's available stock for a transfer (TRANSFER, negative); null (nothing
   * written) when fewer are available, so units reserved for orders never leave. A lot-tracked variant ships only
   * unexpired lots, first expiry first, and only units the reservations there do not need.
   */
  async transferOut(
    tx: Tx,
    variantId: string,
    locationId: string,
    quantity: number,
    source: MovementSource,
  ): Promise<StockMovement | null> {
    await this.repository.ensureLevel(tx, variantId, locationId);
    const movements = await this.move(tx, variantId, locationId, transferOutEffect(quantity), source, {
      policy: DrawPolicy.Transfer,
    });
    return movements?.[0] ?? null;
  }

  /**
   * Adds `quantity` units that arrived at the location on a transfer (TRANSFER, positive); a lot-tracked variant
   * needs the `lots` they came in.
   */
  async transferIn(
    tx: Tx,
    variantId: string,
    locationId: string,
    quantity: number,
    source: MovementSource,
    lots?: LotQuantity[],
  ): Promise<StockMovement> {
    await this.repository.ensureLevel(tx, variantId, locationId);
    const movements = await this.move(tx, variantId, locationId, transferInEffect(quantity), source, { lots });
    if (!movements) throw new Error(`Stock level of variant "${variantId}" refused a transfer receipt of ${quantity}`);
    return movements[0];
  }

  /**
   * Units of the variant that can still be sold or transferred at the location (default): on hand, not reserved and
   * not in an expired lot.
   */
  async available(tx: Tx, variantId: string, locationId?: string): Promise<number> {
    locationId ??= await this.repository.defaultLocationId(tx);
    const level = await this.repository.findLevel(tx, variantId, locationId);
    if (!level) return 0;
    const expired = expiredUnits(await this.lots.findLots(tx, variantId, locationId), new Date());
    return Math.max(0, level.onHand - level.reserved - expired);
  }

  /**
   * Holds `quantity` units for an order line at the line's location (default) if that many are available there;
   * false (nothing written) otherwise.
   */
  async reserve(
    tx: Tx,
    line: {
      variantId: string;
      quantity: number;
      orderId: string;
      orderItemId: string;
      expiresAt: Date | null;
      locationId?: string;
    },
    actorId?: string,
  ): Promise<boolean> {
    const locationId = line.locationId ?? (await this.repository.defaultLocationId(tx));
    const movements = await this.move(tx, line.variantId, locationId, reserveEffect(line.quantity), {
      refType: 'Order',
      refId: line.orderId,
      actorId,
    });
    if (!movements) return false;
    await this.repository.createReservation(tx, {
      variantId: line.variantId,
      quantity: line.quantity,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      expiresAt: line.expiresAt,
      locationId,
    });
    return true;
  }

  /**
   * The sale happened (online payment captured, or a cash-on-delivery order dispatched): ACTIVE -> CONSUMED, and the
   * line's unit cost is snapshotted for margins. A lot-tracked variant's units come from its unexpired lots, first expiry first; if they run short (expired units
   * held for the order), the expired lots make up the rest and a warning is logged.
   */
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
      await this.moveOrFail(
        tx,
        reservation,
        consumeEffect(reservation.quantity),
        { refType: 'Order', refId: orderId, actorId },
        { policy: DrawPolicy.Sale },
      );
      await this.repository.recordSaleCost(tx, reservation.orderItemId);
      consumed += 1;
    }
    return consumed;
  }

  /**
   * The order was cancelled or expired: every ACTIVE or CONSUMED reservation becomes RELEASED, exactly once. Units of
   * a consumed lot-tracked sale go back into the lots the order drew them from.
   */
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
        await this.moveOrFail(
          tx,
          reservation,
          releaseEffect(from, reservation.quantity)!,
          { ...source, refType: 'Order', refId: orderId },
          { restockOrderId: orderId },
        );
        released += 1;
        break;
      }
    }
    return released;
  }

  /**
   * Writes the units of the variant's expired lots at the location off sellable stock: one ADJUSTMENT (EXPIRED, ref
   * the Lot) per lot, never taking stock below the units reserved there. Returns the units written off and those left
   * because orders hold them.
   */
  async writeOffExpiredLots(
    tx: Tx,
    variantId: string,
    locationId: string,
    now: Date,
  ): Promise<{ writtenOff: number; blocked: number }> {
    const level = await this.lots.lockLevel(tx, variantId, locationId);
    if (!level) return { writtenOff: 0, blocked: 0 };
    const plan = expiryWriteOff(
      await this.lots.lockLots(tx, variantId, locationId),
      level.onHand - level.reserved,
      now,
    );
    let writtenOff = 0;
    for (const part of plan.writeOff) {
      const movements = await this.adjustLots(
        tx,
        variantId,
        locationId,
        -part.quantity,
        { adjustmentReason: StockAdjustmentReason.EXPIRED, refType: 'Lot', refId: part.lotId, note: 'Lot expired' },
        [part],
      );
      if (!movements) throw new Error(`Stock level refused writing off expired lot "${part.lotId}"`);
      writtenOff += part.quantity;
    }
    return { writtenOff, blocked: plan.blocked };
  }

  private async moveOrFail(
    tx: Tx,
    reservation: { variantId: string; locationId: string; id: string },
    effect: StockEffect,
    source: MovementSource,
    lotPlan: LotPlan,
  ): Promise<void> {
    const movements = await this.move(tx, reservation.variantId, reservation.locationId, effect, source, lotPlan);
    // The level always covers its reservations (reserved <= onHand); a refusal means the ledger is corrupt.
    if (!movements) throw new Error(`Stock level refused the ${effect.reason} of reservation "${reservation.id}"`);
  }

  private async move(
    tx: Tx,
    variantId: string,
    locationId: string,
    effect: StockEffect,
    source: MovementSource,
    lotPlan: LotPlan = {},
  ): Promise<StockMovement[] | null> {
    const tracked = effect.onHandDelta !== 0 && (await this.lots.isTracked(tx, variantId));
    if (!tracked && lotPlan.lots?.length) {
      throw new BadRequestException(`Variant "${variantId}" does not track lots; leave the lot out`);
    }
    const parts = tracked ? await this.lotParts(tx, variantId, locationId, effect, lotPlan, source) : null;
    if (parts === REFUSED) return null;

    const after = await this.repository.applyEffect(tx, variantId, locationId, effect);
    if (!after) return null;
    const movements: StockMovement[] = [];
    if (parts === null) {
      movements.push(await this.repository.insertMovement(tx, { variantId, locationId, ...effect, ...source }));
    } else {
      const sign = Math.sign(effect.onHandDelta);
      for (const part of parts) {
        if (sign > 0) await this.lots.ensureLotStock(tx, part.lotId, locationId);
        if (!(await this.lots.applyLotDelta(tx, part.lotId, locationId, sign * part.quantity))) {
          throw new Error(`Lot "${part.lotId}" at "${locationId}" refused a change of ${sign * part.quantity}`);
        }
        movements.push(
          await this.repository.insertMovement(tx, {
            variantId,
            locationId,
            reason: effect.reason,
            onHandDelta: sign * part.quantity,
            reservedDelta: effect.reservedDelta === 0 ? 0 : Math.sign(effect.reservedDelta) * part.quantity,
            ...source,
            lotId: part.lotId,
          }),
        );
      }
    }

    const change = effect.onHandDelta - effect.reservedDelta;
    if (change < 0) {
      // The threshold is per variant, so it is checked against what is available across the active locations.
      const total = await this.repository.activeAvailable(tx, variantId, locationId);
      const availableBefore = total.available - (total.locationActive ? change : 0);
      const variant = await this.repository.findVariantForAlert(tx, variantId);
      const threshold = variant?.lowStockThreshold ?? null;
      if (crossesLowStock(availableBefore, total.available, threshold)) {
        await this.outbox.record(tx, {
          type: 'inventory.low_stock.v1',
          aggregateId: variantId,
          payload: { variantId, locationId, available: total.available, movementId: movements[0].id },
        });
      }
    }
    return movements;
  }

  /**
   * The lots a lot-tracked change touches, or REFUSED when the units are not there. Removals lock the level and then
   * its lots (always in that order, so concurrent changes cannot deadlock) and draw from the lots named or by FEFO.
   */
  private async lotParts(
    tx: Tx,
    variantId: string,
    locationId: string,
    effect: StockEffect,
    plan: LotPlan,
    source: MovementSource,
  ): Promise<LotQuantity[] | typeof REFUSED> {
    const quantity = Math.abs(effect.onHandDelta);
    let parts: LotQuantity[] | null;
    if (effect.onHandDelta > 0) {
      parts = plan.lots?.length
        ? plan.lots
        : plan.restockOrderId
          ? allocateFromDrawn(await this.lots.orderLotDraws(tx, plan.restockOrderId, variantId), quantity)
          : null;
      if (!parts) {
        if (plan.restockOrderId) {
          throw new Error(
            `Order "${plan.restockOrderId}" drew fewer than ${quantity} units of "${variantId}" from lots`,
          );
        }
        throw new BadRequestException(
          `Variant "${variantId}" tracks lots: give the lot number and expiry of the units added`,
        );
      }
    } else {
      const level = await this.lots.lockLevel(tx, variantId, locationId);
      const lots = await this.lots.lockLots(tx, variantId, locationId);
      const now = new Date();
      if (plan.lots?.length) {
        const held = new Map(lots.map((lot) => [lot.lotId, lot.onHand]));
        if (plan.lots.some((part) => (held.get(part.lotId) ?? 0) < part.quantity)) return REFUSED;
        parts = plan.lots;
      } else {
        const policy = plan.policy ?? DrawPolicy.Removal;
        // The lots add up to onHand, so outside a transfer a short draw means the level would refuse it too.
        parts = fefoDraw(lots, quantity, now, policy);
        if (!parts) return REFUSED;
        // Units sent away must not be the ones the reservations here will need when they are consumed.
        const freshLeft = lots.reduce((sum, lot) => sum + lot.onHand, 0) - expiredUnits(lots, now) - quantity;
        if (policy === DrawPolicy.Transfer && freshLeft < (level?.reserved ?? 0)) return REFUSED;
        const fromExpired = policy === DrawPolicy.Sale ? expiredInDraw(parts, lots, now) : 0;
        if (fromExpired > 0) {
          this.logger.warn('Sale consumed units of expired lots: no unexpired units were left', CONTEXT, {
            variantId,
            locationId,
            units: fromExpired,
            refType: source.refType,
            refId: source.refId,
          });
        }
      }
    }
    const total = parts.reduce((sum, part) => sum + part.quantity, 0);
    if (total !== quantity || parts.some((part) => part.quantity <= 0)) {
      throw new BadRequestException(`The lot quantities add up to ${total}, not the ${quantity} units moved`);
    }
    return parts;
  }
}

const REFUSED = Symbol('refused');

interface LotPlan {
  /** The lots to add to or take from, each with its units (positive) */
  lots?: LotQuantity[];
  /** A removal without lots named draws by this policy (default REMOVAL) */
  policy?: DrawPolicy;
  /** Units back from this order's sale go into the lots it drew them from */
  restockOrderId?: string;
}
