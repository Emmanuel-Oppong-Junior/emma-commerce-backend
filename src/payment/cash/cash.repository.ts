import { Injectable } from '@nestjs/common';
import { CashCollection, CashRemittance, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RiderCashRow } from './cash-report';
import { RemittingRiderFacts } from './cash-remittance';

type Tx = Prisma.TransactionClient;

export type CollectionRecord = CashCollection & { orderNumber: number };
export type RemittanceRecord = CashRemittance & { collections: CollectionRecord[] };

export interface LockedCollection {
  id: string;
  riderId: string | null;
  remittanceId: string | null;
  amount: Prisma.Decimal;
}

export interface NewRemittance {
  riderId: string;
  receivedById: string;
  amount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  discrepancy: Prisma.Decimal;
  currency: string;
  note: string | null;
  receivedAt: Date;
}

export interface UncollectedDeliveryRow {
  orderId: string;
  orderNumber: number;
  grandTotal: Prisma.Decimal;
  deliveredAt: Date;
}

const WITH_ORDER_NUMBER = { order: { select: { orderNumber: true } } } as const;
const UNCOLLECTED_DELIVERIES_LISTED = 100;

function toCollectionRecord({
  order,
  ...collection
}: CashCollection & { order: { orderNumber: number } }): CollectionRecord {
  return { ...collection, orderNumber: order.orderNumber };
}

// A delivered cash-on-delivery shipment whose order has no cash collection. Shipments migrated without a delivery
// time fall back to their last update.
function uncollectedDeliveries(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT o.id AS "orderId", o."orderNumber", o."grandTotal", COALESCE(s."deliveredAt", s."updatedAt") AS "deliveredAt"
    FROM "Shipment" s
    JOIN "Order" o ON o.id = s."orderId"
    WHERE o."paymentMethod" = 'CASH_ON_DELIVERY'
      AND s.status = 'DELIVERED'
      AND COALESCE(s."deliveredAt", s."updatedAt") >= ${from}
      AND COALESCE(s."deliveredAt", s."updatedAt") < ${to}
      AND NOT EXISTS (SELECT 1 FROM "CashCollection" cc WHERE cc."orderId" = o.id)`;
}

@Injectable()
export class CashRepository {
  constructor(private readonly prisma: PrismaService) {}

  runTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async findRemittingRider(tx: Tx, riderId: string): Promise<RemittingRiderFacts | null> {
    const rider = await tx.user.findUnique({
      where: { id: riderId },
      select: { isActive: true, storeMemberships: { select: { id: true }, take: 1 } },
    });
    if (!rider) return null;
    const collection = await tx.cashCollection.findFirst({ where: { riderId }, select: { id: true } });
    return {
      isActive: rider.isActive,
      isStaff: rider.storeMemberships.length > 0,
      hasCollections: collection !== null,
    };
  }

  /** Row-locks the collections (in id order, so concurrent remittances cannot deadlock) and reads them. */
  lockCollections(tx: Tx, ids: string[]): Promise<LockedCollection[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.$queryRaw<LockedCollection[]>`
      SELECT id, "riderId", "remittanceId", amount FROM "CashCollection"
      WHERE id IN (${Prisma.join(ids)})
      ORDER BY id
      FOR UPDATE`;
  }

  createRemittance(tx: Tx, data: NewRemittance): Promise<CashRemittance> {
    return tx.cashRemittance.create({ data });
  }

  /** Links the collections to the remittance only while they are still this rider's and unremitted. */
  async linkCollections(tx: Tx, remittanceId: string, riderId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await tx.cashCollection.updateMany({
      where: { id: { in: ids }, riderId, remittanceId: null },
      data: { remittanceId },
    });
    return count;
  }

  async findRemittance(tx: Tx, id: string): Promise<RemittanceRecord> {
    const remittance = await tx.cashRemittance.findUniqueOrThrow({
      where: { id },
      include: { collections: { include: WITH_ORDER_NUMBER, orderBy: { collectedAt: 'asc' } } },
    });
    return { ...remittance, collections: remittance.collections.map(toCollectionRecord) };
  }

  async findRemittances(riderId: string | undefined, take: number): Promise<RemittanceRecord[]> {
    const remittances = await this.prisma.cashRemittance.findMany({
      where: { ...(riderId && { riderId }) },
      include: { collections: { include: WITH_ORDER_NUMBER, orderBy: { collectedAt: 'asc' } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return remittances.map((remittance) => ({
      ...remittance,
      collections: remittance.collections.map(toCollectionRecord),
    }));
  }

  async findUnremittedCollections(riderId: string): Promise<CollectionRecord[]> {
    const collections = await this.prisma.cashCollection.findMany({
      where: { riderId, remittanceId: null },
      include: WITH_ORDER_NUMBER,
      orderBy: [{ collectedAt: 'asc' }, { id: 'asc' }],
    });
    return collections.map(toCollectionRecord);
  }

  /** Per rider: collections taken in [from, to) (and how many are still unremitted), remittances received in it. */
  findRiderCashRows(from: Date, to: Date, riderId?: string): Promise<RiderCashRow[]> {
    const collectionRider = riderId ? Prisma.sql`AND cc."riderId" = ${riderId}` : Prisma.empty;
    const remittanceRider = riderId ? Prisma.sql`AND r."riderId" = ${riderId}` : Prisma.empty;
    return this.prisma.$queryRaw<RiderCashRow[]>`
      WITH collected AS (
        SELECT cc."riderId",
          count(*)::int AS "collectionsCount",
          sum(cc.amount) AS "collectedTotal",
          (count(*) FILTER (WHERE cc."remittanceId" IS NULL))::int AS "outstandingCount",
          COALESCE(sum(cc.amount) FILTER (WHERE cc."remittanceId" IS NULL), 0) AS "outstandingTotal"
        FROM "CashCollection" cc
        WHERE cc."riderId" IS NOT NULL AND cc."collectedAt" >= ${from} AND cc."collectedAt" < ${to} ${collectionRider}
        GROUP BY cc."riderId"
      ),
      remitted AS (
        SELECT r."riderId",
          count(*)::int AS "remittancesCount",
          sum(r.amount) AS "remittedTotal",
          (count(*) FILTER (WHERE r.discrepancy <> 0))::int AS "discrepancyCount",
          COALESCE(sum(-r.discrepancy) FILTER (WHERE r.discrepancy < 0), 0) AS "shortTotal",
          COALESCE(sum(r.discrepancy) FILTER (WHERE r.discrepancy > 0), 0) AS "overTotal"
        FROM "CashRemittance" r
        WHERE r."receivedAt" >= ${from} AND r."receivedAt" < ${to} ${remittanceRider}
        GROUP BY r."riderId"
      )
      SELECT u.id AS "riderId", u.name AS "riderName",
        COALESCE(c."collectionsCount", 0) AS "collectionsCount",
        COALESCE(c."collectedTotal", 0) AS "collectedTotal",
        COALESCE(c."outstandingCount", 0) AS "outstandingCount",
        COALESCE(c."outstandingTotal", 0) AS "outstandingTotal",
        COALESCE(m."remittancesCount", 0) AS "remittancesCount",
        COALESCE(m."remittedTotal", 0) AS "remittedTotal",
        COALESCE(m."discrepancyCount", 0) AS "discrepancyCount",
        COALESCE(m."shortTotal", 0) AS "shortTotal",
        COALESCE(m."overTotal", 0) AS "overTotal"
      FROM collected c
      FULL OUTER JOIN remitted m ON m."riderId" = c."riderId"
      JOIN "User" u ON u.id = COALESCE(c."riderId", m."riderId")`;
  }

  async findUncollectedDeliveries(
    from: Date,
    to: Date,
  ): Promise<{ count: number; total: Prisma.Decimal; orders: UncollectedDeliveryRow[] }> {
    const [summary] = await this.prisma.$queryRaw<{ count: number; total: Prisma.Decimal }[]>`
      SELECT count(*)::int AS count, COALESCE(sum("grandTotal"), 0) AS total FROM (${uncollectedDeliveries(from, to)}) d`;
    const orders = await this.prisma.$queryRaw<UncollectedDeliveryRow[]>`
      SELECT * FROM (${uncollectedDeliveries(from, to)}) d
      ORDER BY "deliveredAt", "orderId"
      LIMIT ${UNCOLLECTED_DELIVERIES_LISTED}`;
    return { count: summary.count, total: summary.total, orders };
  }
}
