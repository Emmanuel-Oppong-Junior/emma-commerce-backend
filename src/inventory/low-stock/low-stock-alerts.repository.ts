import { Injectable } from '@nestjs/common';
import { LowStockAlertStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OWNER_ROLE_KEY, Permission } from '../../iam/authorization/permissions';
import { DigestItem, PendingLowStockAlert } from './low-stock-digest';

type Db = Prisma.TransactionClient;

export const LOW_STOCK_ALERTS_PERMISSION: Permission = 'inventory.alerts';

/** Pending low-stock alerts and the digests that list them; writes run on the caller's transaction. */
@Injectable()
export class LowStockAlertsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores the alert of one `inventory.low_stock.v1` event unless the variant already has a PENDING alert at that
   * location or the event was stored before (redelivery); nothing when the variant or location is gone. True if stored.
   */
  async recordPending(
    eventId: string,
    alert: { variantId: string; locationId: string; available: number },
  ): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "LowStockAlert" ("id", "variantId", "locationId", "eventId", "availableAtAlert")
      SELECT gen_random_uuid()::text, v."id", l."id", ${eventId}, ${alert.available}::int
      FROM "Variant" v JOIN "StockLocation" l ON l."id" = ${alert.locationId}
      WHERE v."id" = ${alert.variantId}
      ON CONFLICT DO NOTHING`;
    return inserted === 1;
  }

  async tryAdvisoryLock(db: Db, lockKey: number): Promise<boolean> {
    const [{ locked }] = await db.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked`;
    return locked;
  }

  /**
   * PENDING alerts, oldest first, row-locked, with the variant's available stock now summed over the active locations
   * (the rule the event uses).
   */
  async lockPending(db: Db): Promise<PendingLowStockAlert[]> {
    return db.$queryRaw<PendingLowStockAlert[]>`
      SELECT a."id", a."variantId", a."locationId",
             (SELECT COALESCE(SUM(sl."onHand" - sl."reserved"), 0)
                FROM "StockLevel" sl JOIN "StockLocation" l ON l."id" = sl."locationId"
               WHERE sl."variantId" = a."variantId" AND l."isActive")::int AS "available",
             v."lowStockThreshold" AS "threshold"
      FROM "LowStockAlert" a
      JOIN "Variant" v ON v."id" = a."variantId"
      WHERE a."status" = 'PENDING'
      ORDER BY a."createdAt", a."id"
      FOR UPDATE OF a`;
  }

  async markDropped(db: Db, ids: string[], at: Date): Promise<void> {
    await db.lowStockAlert.updateMany({
      where: { id: { in: ids }, status: LowStockAlertStatus.PENDING },
      data: { status: LowStockAlertStatus.DROPPED, resolvedAt: at },
    });
  }

  async markSent(db: Db, digestId: string, alerts: { id: string; available: number }[], at: Date): Promise<void> {
    for (const alert of alerts) {
      await db.lowStockAlert.update({
        where: { id: alert.id },
        data: { status: LowStockAlertStatus.SENT, digestId, availableAtDigest: alert.available, resolvedAt: at },
      });
    }
  }

  /** Active users whose staff role holds inventory.alerts (the Owner holds every permission). */
  async alertRecipientIds(db: Db): Promise<string[]> {
    const users = await db.user.findMany({
      where: {
        isActive: true,
        storeMemberships: {
          some: { role: { OR: [{ key: OWNER_ROLE_KEY }, { permissions: { has: LOW_STOCK_ALERTS_PERMISSION } }] } },
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return users.map((user) => user.id);
  }

  /** What a digest lists, for its email. */
  async digestItems(digestId: string): Promise<DigestItem[]> {
    const rows = await this.prisma.lowStockAlert.findMany({
      where: { digestId, status: LowStockAlertStatus.SENT },
      select: {
        availableAtDigest: true,
        location: { select: { name: true } },
        variant: { select: { sku: true, lowStockThreshold: true, product: { select: { name: true } } } },
      },
    });
    return rows.map((row) => {
      // A CHECK constraint sets availableAtDigest on every SENT alert.
      if (row.availableAtDigest === null) throw new Error(`Alert of digest "${digestId}" has no availableAtDigest`);
      return {
        locationName: row.location.name,
        productName: row.variant.product.name,
        sku: row.variant.sku,
        available: row.availableAtDigest,
        threshold: row.variant.lowStockThreshold,
      };
    });
  }
}
