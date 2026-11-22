import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Lot, Prisma, StockMovement, StockMovementReason } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MovementSource, StockLedgerService } from '../stock-ledger.service';
import { LotStockRepository, LotWithStock } from './lot-stock.repository';
import {
  allocateFromDrawn,
  assignTransferReceipt,
  DEFAULT_EXPIRING_WITHIN_DAYS,
  expiringStockLines,
  ExpiringStockLine,
  expiringWindowProblem,
  isExpired,
  LotQuantity,
  LotSpec,
  lotSpecProblem,
  lotTrackingChangeProblem,
} from './lots';

type Tx = Prisma.TransactionClient;

export const LOT_EXPIRY_LOCK_KEY = 70_412_007;
const MAX_EXPIRY_RUN_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiryRun {
  /** Units written off, per (variant, location) that had expired units */
  groups: { variantId: string; locationId: string; writtenOff: number; blocked: number }[];
}

/**
 * Lots with expiry (P4-C.1): finding or creating the lot of a receipt, the lots a return or transfer puts units back
 * into, the rule for switching tracking, the hourly write-off of expired lots and the expiring-stock report. Stock
 * itself moves only through StockLedgerService.
 */
@Injectable()
export class LotsService {
  constructor(
    private readonly repository: LotStockRepository,
    private readonly ledger: StockLedgerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The variant's lot named by `spec`, created when new. A receipt (`expiryRequired`) must give the expiry; otherwise
   * it is needed only for a new lot. An existing lot's expiry must match, and expired lots take no units.
   * @throws BadRequestException naming the problem.
   */
  async resolveLot(tx: Tx, variantId: string, spec: LotSpec, now: Date, expiryRequired: boolean): Promise<Lot> {
    const lotNumber = spec.lotNumber.trim();
    const existing = lotNumber ? await this.repository.findLot(tx, variantId, lotNumber) : null;
    const problem = lotSpecProblem(spec, existing, now, expiryRequired);
    if (problem) throw new BadRequestException(problem);
    if (existing) return existing;
    const lot = await this.repository.insertLot(tx, {
      variantId,
      lotNumber,
      expiresAt: spec.expiresAt!,
      manufacturedAt: spec.manufacturedAt ?? null,
    });
    // A concurrent receipt may have created the same lot number first: it must agree on the expiry too.
    const raced = lotSpecProblem(spec, lot, now, expiryRequired);
    if (raced) throw new BadRequestException(raced);
    return lot;
  }

  /**
   * An existing lot of the variant, for a return or an adjustment that names one.
   * @throws BadRequestException when the variant has no such lot, or it expired.
   */
  async existingLot(tx: Tx, variantId: string, spec: LotSpec, now: Date): Promise<Lot> {
    const lotNumber = spec.lotNumber.trim();
    const lot = await this.repository.findLot(tx, variantId, lotNumber);
    if (!lot) throw new BadRequestException(`Variant "${variantId}" has no lot "${lotNumber}"`);
    const problem = lotSpecProblem(spec, lot, now, false);
    if (problem) throw new BadRequestException(problem);
    return lot;
  }

  /**
   * The lot a removal names (expired or not: damaged or expired units of it are written off).
   * @throws BadRequestException when the variant has no such lot, or the expiry given does not match.
   */
  async lotToRemoveFrom(tx: Tx, variantId: string, spec: LotSpec): Promise<Lot> {
    const lotNumber = spec.lotNumber.trim();
    const lot = await this.repository.findLot(tx, variantId, lotNumber);
    if (!lot) throw new BadRequestException(`Variant "${variantId}" has no lot "${lotNumber}"`);
    if (spec.expiresAt && spec.expiresAt.getTime() !== lot.expiresAt.getTime()) {
      throw new BadRequestException(`Lot "${lotNumber}" expires at ${lot.expiresAt.toISOString()}`);
    }
    return lot;
  }

  /**
   * Receives `quantity` units of a variant into the lot `spec` names (created when new, expiry required and in the
   * future): the receipt path purchasing (P4-E) reuses. Runs on the caller's transaction.
   */
  async receiveIntoLot(
    tx: Tx,
    input: {
      variantId: string;
      quantity: number;
      lot: LotSpec;
      locationId?: string;
      source: MovementSource;
    },
    now: Date,
  ): Promise<{ lot: Lot; movement: StockMovement }> {
    const lot = await this.resolveLot(tx, input.variantId, input.lot, now, true);
    const movement = await this.ledger.receive(
      tx,
      input.variantId,
      input.quantity,
      StockMovementReason.RECEIPT,
      input.source,
      input.locationId,
      [{ lotId: lot.id, quantity: input.quantity }],
    );
    return { lot, movement };
  }

  /** Units of the lot at the location. */
  lotOnHandAt(tx: Tx, lotId: string, locationId: string): Promise<number> {
    return this.repository.lotOnHandAt(tx, lotId, locationId);
  }

  /**
   * The lots returned units of an order go back into by default: those its sales drew from and nothing has put back
   * yet, unexpired, earliest expiry first.
   * @throws BadRequestException when they cannot take `quantity` units (expired or not attributable): name the lot.
   */
  async returnLots(tx: Tx, orderId: string, variantId: string, quantity: number, now: Date): Promise<LotQuantity[]> {
    const drawn = (await this.repository.orderLotDraws(tx, orderId, variantId)).filter(
      (lot) => !isExpired(lot.expiresAt, now),
    );
    const lots = allocateFromDrawn(drawn, quantity);
    if (!lots) {
      throw new BadRequestException(
        `The order's sales of variant "${variantId}" drew fewer than ${quantity} units from unexpired lots; ` +
          'name the lot the returned units belong to',
      );
    }
    return lots;
  }

  /** The lots the units that arrived on a transfer go into (none for an untracked variant). */
  async transferReceiptLots(
    tx: Tx,
    transfer: { id: string; fromLocationId: string },
    variantId: string,
    received: number,
  ): Promise<LotQuantity[] | undefined> {
    const dispatched = await this.repository.transferLots(tx, transfer.id, variantId, transfer.fromLocationId);
    return dispatched.length > 0 ? assignTransferReceipt(dispatched, received) : undefined;
  }

  /** The lot a stock-take surplus of the variant goes into: its latest-expiring lot; null when it has none. */
  surplusLot(tx: Tx, variantId: string): Promise<Lot | null> {
    return this.repository.latestExpiringLot(tx, variantId);
  }

  isTracked(tx: Tx, variantId: string): Promise<boolean> {
    return this.repository.isTracked(tx, variantId);
  }

  /**
   * Refuses switching the product's lot tracking while it holds stock (on hand, in transit or sold awaiting
   * dispatch), with the product row locked so no stock change interleaves. Call inside the update's transaction.
   * @throws NotFoundException; BadRequestException with the stock that blocks it.
   */
  async assertTrackingChange(tx: Tx, productId: string, enable: boolean): Promise<void> {
    const product = await this.repository.lockProduct(tx, productId);
    if (!product) throw new NotFoundException('Product not found');
    if (product.trackLots === enable) return;
    const problem = lotTrackingChangeProblem(enable, await this.repository.trackingChangeStock(tx, productId));
    if (problem) throw new BadRequestException(problem);
  }

  /**
   * Writes the units of every expired lot off sellable stock (see StockLedgerService.writeOffExpiredLots), in one
   * transaction under an advisory lock; null when another run holds it. Repeating a run writes nothing more.
   */
  async writeOffExpired(now: Date): Promise<ExpiryRun | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${LOT_EXPIRY_LOCK_KEY}::bigint) AS locked`;
        if (!locked) return null;
        const groups: ExpiryRun['groups'] = [];
        for (const { variantId, locationId } of await this.repository.findExpiredStock(tx, now)) {
          const outcome = await this.ledger.writeOffExpiredLots(tx, variantId, locationId, now);
          groups.push({ variantId, locationId, ...outcome });
        }
        return { groups };
      },
      { timeout: MAX_EXPIRY_RUN_MS },
    );
  }

  /**
   * Lots with units on hand expiring within `withinDays` (expired ones included), soonest first, optionally at one
   * location or in one category.
   * @throws BadRequestException for a window outside 1-365 days.
   */
  async expiringStock(
    filter: { withinDays?: number; locationId?: string; categoryId?: string },
    now: Date,
  ): Promise<ExpiringStockLine[]> {
    const withinDays = filter.withinDays ?? DEFAULT_EXPIRING_WITHIN_DAYS;
    const problem = expiringWindowProblem(withinDays);
    if (problem) throw new BadRequestException(problem);
    const rows = await this.repository.findExpiringRows({
      before: new Date(now.getTime() + withinDays * DAY_MS),
      locationId: filter.locationId,
      categoryId: filter.categoryId,
    });
    return expiringStockLines(rows, now);
  }

  variantLots(variantId: string): Promise<LotWithStock[]> {
    return this.repository.findVariantLots(variantId);
  }

  findLotsByIds(ids: readonly string[]): Promise<Lot[]> {
    return this.repository.findLotsByIds(ids);
  }
}
