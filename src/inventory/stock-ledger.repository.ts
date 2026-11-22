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
import { LedgerTotals } from './stock-reconciliation';

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
   * concurrent changes can never oversell. Returns the counts after the change, or null if refused or missing.
   */
  async applyEffect(db: Db, variantId: string, locationId: string, effect: StockEffect): Promise<StockCounts | null> {
    const [after] = await db.$queryRaw<StockCounts[]>`
      UPDATE "StockLevel"
      SET "onHand" = "onHand" + ${effect.onHandDelta}::int, "reserved" = "reserved" + ${effect.reservedDelta}::int,
          "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "variantId" = ${variantId} AND "locationId" = ${locationId}
        AND "onHand" + ${effect.onHandDelta}::int >= "reserved" + ${effect.reservedDelta}::int
        AND "reserved" + ${effect.reservedDelta}::int >= 0
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

  async findVariantForAlert(db: Db, variantId: string): Promise<{ lowStockThreshold: number | null } | null> {
    return db.variant.findUnique({ where: { id: variantId }, select: { lowStockThreshold: true } });
  }

  async returnRequestExists(db: Db, id: string): Promise<boolean> {
    return (await db.returnRequest.count({ where: { id } })) > 0;
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
