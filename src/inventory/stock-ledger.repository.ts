import { Injectable } from '@nestjs/common';
import {
  Prisma,
  StockAdjustmentReason,
  StockMovement,
  StockMovementReason,
  StockReservation,
  StockReservationStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockCounts, StockEffect } from './stock';
import { LedgerTotals, LotTotals } from './stock-reconciliation';
import { expiredLotUnitsSql } from './lots/lot-stock.repository';

type Db = Prisma.TransactionClient;

export interface NewMovement {
  variantId: string;
  locationId: string;
  onHandDelta: number;
  reservedDelta: number;
  reason: StockMovementReason;
  refType?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  adjustmentReason?: StockAdjustmentReason;
  lotId?: string;
  unitCost?: Prisma.Decimal;
}

export interface NewReservation {
  variantId: string;
  locationId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  expiresAt: Date | null;
}

export interface MovementFilter {
  variantId?: string;
  productId?: string;
  reason?: StockMovementReason;
}

/** Data access for stock levels, reservations and the movement ledger; writes run on the caller's transaction. */
@Injectable()
export class StockLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The store's default stock location, where all stock lives until fulfilment picks locations by rule. */
  async defaultLocationId(db: Db): Promise<string> {
    const location = await db.stockLocation.findFirst({
      where: { isDefault: true, store: { singleton: true } },
      select: { id: true },
    });
    if (!location) throw new Error('No default stock location exists; apply the database migrations');
    return location.id;
  }

  /** An active stock location of the store, or null. */
  async findActiveLocation(db: Db, id: string): Promise<{ id: string } | null> {
    return db.stockLocation.findFirst({
      where: { id, isActive: true, store: { singleton: true } },
      select: { id: true },
    });
  }

  async ensureLevel(db: Db, variantId: string, locationId: string): Promise<void> {
    await db.$executeRaw`
      INSERT INTO "StockLevel" ("id", "variantId", "locationId", "updatedAt")
      VALUES (${`${variantId}_${locationId}`}, ${variantId}, ${locationId}, CURRENT_TIMESTAMP)
      ON CONFLICT ("variantId", "locationId") DO NOTHING`;
  }

  /**
   * Applies `effect` only if the level stays valid (0 <= reserved <= onHand), in one conditional statement, so
   * concurrent changes can never oversell. A reservation also leaves the units of expired lots alone (P4-C.1).
   * Returns the counts after the change, or null if refused or missing.
   */
  async applyEffect(db: Db, variantId: string, locationId: string, effect: StockEffect): Promise<StockCounts | null> {
    const expiredGuard =
      effect.reason === StockMovementReason.RESERVE
        ? Prisma.sql`AND "onHand" - ("reserved" + ${effect.reservedDelta}::int) >= ${expiredLotUnitsSql('StockLevel', new Date())}`
        : Prisma.empty;
    const [after] = await db.$queryRaw<StockCounts[]>`
      UPDATE "StockLevel"
      SET "onHand" = "onHand" + ${effect.onHandDelta}::int, "reserved" = "reserved" + ${effect.reservedDelta}::int,
          "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "variantId" = ${variantId} AND "locationId" = ${locationId}
        AND "onHand" + ${effect.onHandDelta}::int >= "reserved" + ${effect.reservedDelta}::int
        AND "reserved" + ${effect.reservedDelta}::int >= 0
        ${expiredGuard}
      RETURNING "onHand", "reserved"`;
    return after ?? null;
  }

  async findLevel(db: Db, variantId: string, locationId: string): Promise<StockCounts | null> {
    return db.stockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
      select: { onHand: true, reserved: true },
    });
  }

  async insertMovement(db: Db, movement: NewMovement): Promise<StockMovement> {
    return db.stockMovement.create({ data: movement });
  }

  async createReservation(db: Db, reservation: NewReservation): Promise<StockReservation> {
    return db.stockReservation.create({ data: reservation });
  }

  async findReservations(db: Db, orderId: string, statuses: StockReservationStatus[]): Promise<StockReservation[]> {
    return db.stockReservation.findMany({ where: { orderId, status: { in: statuses } }, orderBy: { id: 'asc' } });
  }

  /** Moves a reservation from `from` to `to` only if it is still `from`; false when another request got there first. */
  async claimReservation(
    db: Db,
    id: string,
    from: StockReservationStatus,
    to: StockReservationStatus,
  ): Promise<boolean> {
    const { count } = await db.stockReservation.updateMany({ where: { id, status: from }, data: { status: to } });
    return count === 1;
  }

  /** The variant's available stock summed over active locations, and whether `locationId` is one of them. */
  async activeAvailable(
    db: Db,
    variantId: string,
    locationId: string,
  ): Promise<{ available: number; locationActive: boolean }> {
    const [row] = await db.$queryRaw<{ available: number; locationActive: boolean }[]>`
      SELECT
        (SELECT COALESCE(sum(sl."onHand" - sl."reserved"), 0)::int
         FROM "StockLevel" sl JOIN "StockLocation" l ON l."id" = sl."locationId"
         WHERE sl."variantId" = ${variantId} AND l."isActive") AS available,
        (SELECT COALESCE(bool_or(l."isActive"), false) FROM "StockLocation" l WHERE l."id" = ${locationId}) AS "locationActive"`;
    return row;
  }

  async findVariantForAlert(db: Db, variantId: string): Promise<{ lowStockThreshold: number | null } | null> {
    return db.variant.findUnique({ where: { id: variantId }, select: { lowStockThreshold: true } });
  }

  /** The return request's order and the location it was fulfilled from; null when the request does not exist. */
  async findReturnRequestLocation(
    db: Db,
    id: string,
  ): Promise<{ orderId: string; stockLocationId: string | null } | null> {
    const request = await db.returnRequest.findUnique({
      where: { id },
      select: { order: { select: { id: true, stockLocationId: true } } },
    });
    return request && { orderId: request.order.id, stockLocationId: request.order.stockLocationId };
  }

  /** Movements newest first, a page of `take` after the `after` cursor (a movement id). */
  async findMovements(
    filter: MovementFilter,
    page: { take: number; after?: string },
  ): Promise<[StockMovement[], number]> {
    const where: Prisma.StockMovementWhereInput = {
      variantId: filter.variantId,
      reason: filter.reason,
      ...(filter.productId && { variant: { productId: filter.productId } }),
    };
    return Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
  }

  /**
   * Every (variant, location) whose StockLevel disagrees with the sum of its movements or of its ACTIVE reservations,
   * with all the totals; a side without rows counts as zero.
   */
  async findLedgerDisagreements(): Promise<LedgerTotals[]> {
    return this.prisma.$queryRaw<LedgerTotals[]>`
      WITH keys AS (
        SELECT "variantId", "locationId" FROM "StockLevel"
        UNION SELECT "variantId", "locationId" FROM "StockMovement"
        UNION SELECT "variantId", "locationId" FROM "StockReservation" WHERE "status" = 'ACTIVE'
      ), moved AS (
        SELECT "variantId", "locationId", sum("onHandDelta")::int AS "onHand", sum("reservedDelta")::int AS "reserved"
        FROM "StockMovement" GROUP BY "variantId", "locationId"
      ), held AS (
        SELECT "variantId", "locationId", sum("quantity")::int AS "quantity"
        FROM "StockReservation" WHERE "status" = 'ACTIVE' GROUP BY "variantId", "locationId"
      ), totals AS (
        SELECT k."variantId", k."locationId",
               COALESCE(sl."onHand", 0) AS "onHand", COALESCE(sl."reserved", 0) AS "reserved",
               COALESCE(m."onHand", 0) AS "movedOnHand", COALESCE(m."reserved", 0) AS "movedReserved",
               COALESCE(h."quantity", 0) AS "activeReserved"
        FROM keys k
        LEFT JOIN "StockLevel" sl ON sl."variantId" = k."variantId" AND sl."locationId" = k."locationId"
        LEFT JOIN moved m ON m."variantId" = k."variantId" AND m."locationId" = k."locationId"
        LEFT JOIN held h ON h."variantId" = k."variantId" AND h."locationId" = k."locationId"
      )
      SELECT * FROM totals
      WHERE "onHand" <> "movedOnHand" OR "reserved" <> "movedReserved" OR "reserved" <> "activeReserved"
      ORDER BY "variantId", "locationId"`;
  }

  /**
   * Lots and levels that disagree with the ledger: a lot's units at a location against the sum of its movements
   * there (LOT_MOVEMENTS), and, for a lot-tracked variant, a level's onHand against the sum of its lots
   * (LOT_TOTAL, lotId null).
   */
  async findLotDisagreements(): Promise<LotTotals[]> {
    return this.prisma.$queryRaw<LotTotals[]>`
      WITH lot_keys AS (
        SELECT "lotId", "locationId" FROM "LotStock"
        UNION SELECT "lotId", "locationId" FROM "StockMovement" WHERE "lotId" IS NOT NULL
      ), lot_moved AS (
        SELECT "lotId", "locationId", sum("onHandDelta")::int AS "onHand"
        FROM "StockMovement" WHERE "lotId" IS NOT NULL GROUP BY "lotId", "locationId"
      ), lot_totals AS (
        SELECT lt."variantId", ls."locationId", sum(ls."onHand")::int AS "onHand"
        FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId" GROUP BY lt."variantId", ls."locationId"
      )
      SELECT 'LOT_MOVEMENTS' AS "kind", lt."variantId", k."locationId", k."lotId",
             COALESCE(m."onHand", 0) AS "expected", COALESCE(ls."onHand", 0) AS "actual"
      FROM lot_keys k
      JOIN "Lot" lt ON lt."id" = k."lotId"
      LEFT JOIN "LotStock" ls ON ls."lotId" = k."lotId" AND ls."locationId" = k."locationId"
      LEFT JOIN lot_moved m ON m."lotId" = k."lotId" AND m."locationId" = k."locationId"
      WHERE COALESCE(m."onHand", 0) <> COALESCE(ls."onHand", 0)
      UNION ALL
      SELECT 'LOT_TOTAL', sl."variantId", sl."locationId", NULL,
             sl."onHand", COALESCE(t."onHand", 0)
      FROM "StockLevel" sl
      JOIN "Variant" v ON v."id" = sl."variantId"
      JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN lot_totals t ON t."variantId" = sl."variantId" AND t."locationId" = sl."locationId"
      WHERE p."trackLots" AND sl."onHand" <> COALESCE(t."onHand", 0)
      ORDER BY 2, 3, 4`;
  }

  async countLevels(): Promise<number> {
    return this.prisma.stockLevel.count();
  }

  /**
   * Runs `fn` only when no other process holds the Postgres advisory lock `lockKey`; returns null otherwise. The lock
   * belongs to a transaction kept open while `fn` runs, so it is released even if the process dies.
   */
  async runWithAdvisoryLock<T>(lockKey: number, maxDurationMs: number, fn: () => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked`;
        return locked ? fn() : null;
      },
      { timeout: maxDurationMs },
    );
  }

  /** On-hand and reserved stock of each variant, summed over locations; variants without a level are absent. */
  async findLevelsByVariant(variantIds: readonly string[]): Promise<Map<string, StockCounts>> {
    const groups = await this.prisma.stockLevel.groupBy({
      by: ['variantId'],
      where: { variantId: { in: [...variantIds] } },
      _sum: { onHand: true, reserved: true },
    });
    return new Map(groups.map((g) => [g.variantId, { onHand: g._sum.onHand ?? 0, reserved: g._sum.reserved ?? 0 }]));
  }
}
