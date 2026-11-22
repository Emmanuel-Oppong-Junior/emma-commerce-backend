import { Injectable } from '@nestjs/common';
import { Lot, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockCounts } from '../stock';
import { ExpiringLotRow, LotQuantity, LotUnits } from './lots';

type Db = Prisma.TransactionClient;

/**
 * Units of lots expired by `now` at the StockLevel row aliased `level` (0 for an untracked variant): on hand, never
 * sellable. Placement, checkout and customer availability subtract it, so a lot that expired since the last
 * expiry-job run is not sold.
 */
export function expiredLotUnitsSql(level: string, now: Date): Prisma.Sql {
  const alias = Prisma.raw(`"${level}"`);
  return Prisma.sql`COALESCE((
    SELECT sum(ls."onHand") FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId"
    WHERE lt."variantId" = ${alias}."variantId" AND ls."locationId" = ${alias}."locationId"
      AND lt."expiresAt" <= ${now}
  ), 0)::int`;
}

export interface ExpiringFilter {
  before: Date;
  locationId?: string;
  categoryId?: string;
}

/** A lot of a variant with its units at each location that holds some. */
export type LotWithStock = Lot & { stock: { locationId: string; onHand: number; location: { name: string } }[] };

/** Data access for lots and their per-location units; writes run on the caller's transaction. */
@Injectable()
export class LotStockRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the variant's product tracks lots, read with a share lock on the product row: switching tracking takes
   * that row for update and refuses while stock exists, so a stock change and a switch cannot interleave.
   */
  async isTracked(db: Db, variantId: string): Promise<boolean> {
    const [row] = await db.$queryRaw<{ trackLots: boolean }[]>`
      SELECT p."trackLots" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
      WHERE v."id" = ${variantId}
      FOR SHARE OF p`;
    return row?.trackLots ?? false;
  }

  /** Locks the product row before tracking is switched (see isTracked). */
  async lockProduct(db: Db, productId: string): Promise<{ trackLots: boolean } | null> {
    const [row] = await db.$queryRaw<{ trackLots: boolean }[]>`
      SELECT "trackLots" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    return row ?? null;
  }

  /** Locks the level row; lots are always locked after their level, so stock changes cannot deadlock. */
  async lockLevel(db: Db, variantId: string, locationId: string): Promise<StockCounts | null> {
    const [row] = await db.$queryRaw<StockCounts[]>`
      SELECT "onHand", "reserved" FROM "StockLevel"
      WHERE "variantId" = ${variantId} AND "locationId" = ${locationId}
      FOR UPDATE`;
    return row ?? null;
  }

  /** The variant's lots holding units at the location, locked (in id order) until the transaction ends. */
  async lockLots(db: Db, variantId: string, locationId: string): Promise<LotUnits[]> {
    return db.$queryRaw<LotUnits[]>`
      SELECT ls."lotId", lt."expiresAt", lt."createdAt", ls."onHand"
      FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId"
      WHERE lt."variantId" = ${variantId} AND ls."locationId" = ${locationId} AND ls."onHand" > 0
      ORDER BY ls."id"
      FOR UPDATE OF ls`;
  }

  /** The variant's lots holding units at the location, without locking them. */
  async findLots(db: Db, variantId: string, locationId: string): Promise<LotUnits[]> {
    return db.$queryRaw<LotUnits[]>`
      SELECT ls."lotId", lt."expiresAt", lt."createdAt", ls."onHand"
      FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId"
      WHERE lt."variantId" = ${variantId} AND ls."locationId" = ${locationId} AND ls."onHand" > 0`;
  }

  async ensureLotStock(db: Db, lotId: string, locationId: string): Promise<void> {
    await db.$executeRaw`
      INSERT INTO "LotStock" ("id", "lotId", "locationId", "updatedAt")
      VALUES (${`${lotId}_${locationId}`}, ${lotId}, ${locationId}, CURRENT_TIMESTAMP)
      ON CONFLICT ("lotId", "locationId") DO NOTHING`;
  }

  /** Moves the lot's units at the location by `delta` unless that takes them below zero; false when refused. */
  async applyLotDelta(db: Db, lotId: string, locationId: string, delta: number): Promise<boolean> {
    const changed = await db.$executeRaw`
      UPDATE "LotStock" SET "onHand" = "onHand" + ${delta}::int, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "lotId" = ${lotId} AND "locationId" = ${locationId} AND "onHand" + ${delta}::int >= 0`;
    return changed === 1;
  }

  async findLot(db: Db, variantId: string, lotNumber: string): Promise<Lot | null> {
    return db.lot.findUnique({ where: { variantId_lotNumber: { variantId, lotNumber } } });
  }

  /** Creates the lot unless a concurrent receipt just did; returns the stored lot either way. */
  async insertLot(
    db: Db,
    lot: { variantId: string; lotNumber: string; expiresAt: Date; manufacturedAt: Date | null },
  ): Promise<Lot> {
    await db.$executeRaw`
      INSERT INTO "Lot" ("id", "variantId", "lotNumber", "expiresAt", "manufacturedAt")
      VALUES (${`lot_${lot.variantId}_${lot.lotNumber}`}, ${lot.variantId}, ${lot.lotNumber}, ${lot.expiresAt},
              ${lot.manufacturedAt})
      ON CONFLICT ("variantId", "lotNumber") DO NOTHING`;
    return db.lot.findUniqueOrThrow({
      where: { variantId_lotNumber: { variantId: lot.variantId, lotNumber: lot.lotNumber } },
    });
  }

  async lotOnHandAt(db: Db, lotId: string, locationId: string): Promise<number> {
    const row = await db.lotStock.findUnique({ where: { lotId_locationId: { lotId, locationId } } });
    return row?.onHand ?? 0;
  }

  /**
   * The lots an order's sales of the variant drew from, with the units not yet put back (by a cancellation or by a
   * return restock of one of its return requests) as `onHand`; only lots with some left.
   */
  async orderLotDraws(db: Db, orderId: string, variantId: string): Promise<LotUnits[]> {
    return db.$queryRaw<LotUnits[]>`
      SELECT m."lotId", lt."expiresAt", lt."createdAt", (-sum(m."onHandDelta"))::int AS "onHand"
      FROM "StockMovement" m JOIN "Lot" lt ON lt."id" = m."lotId"
      WHERE m."variantId" = ${variantId} AND m."reason" IN ('SALE', 'RETURN_RESTOCK')
        AND ((m."refType" = 'Order' AND m."refId" = ${orderId})
          OR (m."refType" = 'ReturnRequest'
              AND m."refId" IN (SELECT "id" FROM "ReturnRequest" WHERE "orderId" = ${orderId})))
      GROUP BY m."lotId", lt."expiresAt", lt."createdAt"
      HAVING -sum(m."onHandDelta") > 0`;
  }

  /** The lots a transfer's dispatch took of the variant, with their units. */
  async transferLots(
    db: Db,
    transferId: string,
    variantId: string,
    sourceLocationId: string,
  ): Promise<(LotQuantity & { expiresAt: Date; createdAt: Date })[]> {
    return db.$queryRaw<(LotQuantity & { expiresAt: Date; createdAt: Date })[]>`
      SELECT m."lotId", lt."expiresAt", lt."createdAt", (-sum(m."onHandDelta"))::int AS "quantity"
      FROM "StockMovement" m JOIN "Lot" lt ON lt."id" = m."lotId"
      WHERE m."refType" = 'StockTransfer' AND m."refId" = ${transferId} AND m."variantId" = ${variantId}
        AND m."locationId" = ${sourceLocationId} AND m."reason" = 'TRANSFER' AND m."onHandDelta" < 0
      GROUP BY m."lotId", lt."expiresAt", lt."createdAt"`;
  }

  /** The variant's lot with the latest expiry (ties: the newest), where a stock-take surplus goes; null if none. */
  async latestExpiringLot(db: Db, variantId: string): Promise<Lot | null> {
    return db.lot.findFirst({ where: { variantId }, orderBy: [{ expiresAt: 'desc' }, { createdAt: 'desc' }] });
  }

  /**
   * The product's stock that would be stranded by switching lot tracking: on hand anywhere, dispatched on transfers
   * not yet received, and sold online but not dispatched (a cancellation would put it back on hand).
   */
  async trackingChangeStock(
    db: Db,
    productId: string,
  ): Promise<{ onHand: number; inTransit: number; awaitingDispatch: number }> {
    const [row] = await db.$queryRaw<{ onHand: number; inTransit: number; awaitingDispatch: number }[]>`
      SELECT
        (SELECT COALESCE(sum(sl."onHand"), 0)::int FROM "StockLevel" sl JOIN "Variant" v ON v."id" = sl."variantId"
         WHERE v."productId" = ${productId}) AS "onHand",
        (SELECT COALESCE(sum(tl."quantity"), 0)::int FROM "StockTransferLine" tl
         JOIN "StockTransfer" t ON t."id" = tl."transferId" JOIN "Variant" v ON v."id" = tl."variantId"
         WHERE v."productId" = ${productId} AND t."status" = 'DISPATCHED') AS "inTransit",
        (SELECT COALESCE(sum(r."quantity"), 0)::int FROM "StockReservation" r
         JOIN "Order" o ON o."id" = r."orderId" JOIN "Variant" v ON v."id" = r."variantId"
         WHERE v."productId" = ${productId} AND r."status" = 'CONSUMED'
           AND o."status" IN ('CONFIRMED', 'IN_FULFILMENT', 'PAYMENT_REVIEW')
           AND NOT EXISTS (
             SELECT 1 FROM "Shipment" s
             WHERE s."orderId" = o."id" AND s."status" NOT IN ('PENDING', 'PICKING', 'PACKED')
           )) AS "awaitingDispatch"`;
    return row;
  }

  /** Every (variant, location) holding units of a lot that has expired by `now`. */
  async findExpiredStock(db: Db, now: Date): Promise<{ variantId: string; locationId: string }[]> {
    return db.$queryRaw<{ variantId: string; locationId: string }[]>`
      SELECT DISTINCT lt."variantId", ls."locationId"
      FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId"
      WHERE ls."onHand" > 0 AND lt."expiresAt" <= ${now}
      ORDER BY lt."variantId", ls."locationId"`;
  }

  /** Lots with units on hand that expire before `filter.before` (expired ones included), one row per location. */
  async findExpiringRows(filter: ExpiringFilter): Promise<ExpiringLotRow[]> {
    return this.prisma.$queryRaw<ExpiringLotRow[]>`
      SELECT lt."id" AS "lotId", lt."lotNumber", lt."expiresAt", lt."manufacturedAt", lt."createdAt" AS "lotCreatedAt",
             v."id" AS "variantId", v."sku", p."id" AS "productId", p."name" AS "productName", v."price",
             l."id" AS "locationId", l."name" AS "locationName", ls."onHand"
      FROM "LotStock" ls
      JOIN "Lot" lt ON lt."id" = ls."lotId"
      JOIN "Variant" v ON v."id" = lt."variantId"
      JOIN "Product" p ON p."id" = v."productId"
      JOIN "StockLocation" l ON l."id" = ls."locationId"
      WHERE ls."onHand" > 0 AND lt."expiresAt" < ${filter.before}
        ${filter.locationId ? Prisma.sql`AND ls."locationId" = ${filter.locationId}` : Prisma.empty}
        ${filter.categoryId ? Prisma.sql`AND p."categoryId" = ${filter.categoryId}` : Prisma.empty}
      ORDER BY lt."expiresAt", lt."createdAt", l."name"`;
  }

  /** The variant's lots, soonest expiry first, with their units at each location holding some. */
  async findVariantLots(variantId: string): Promise<LotWithStock[]> {
    return this.prisma.lot.findMany({
      where: { variantId },
      include: {
        stock: {
          where: { onHand: { gt: 0 } },
          select: { locationId: true, onHand: true, location: { select: { name: true } } },
          orderBy: { location: { name: 'asc' } },
        },
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findLotsByIds(ids: readonly string[]): Promise<Lot[]> {
    return this.prisma.lot.findMany({ where: { id: { in: [...ids] } } });
  }
}
