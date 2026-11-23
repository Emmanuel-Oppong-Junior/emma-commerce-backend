import { Injectable } from '@nestjs/common';
import { Prisma, SerialFormat, SerialUnit, SerialUnitStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingFacts } from './serial-rules';
import { UNDISPATCHED_RESERVED_UNITS } from '../awaiting-dispatch';

type Db = Prisma.TransactionClient;

export interface SerialTracking {
  productId: string;
  trackSerials: boolean;
  serialFormat: SerialFormat;
  warrantyMonths: number | null;
}

export interface SerialEventSource {
  refType?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  movementId?: string;
}

export interface NewSerialEvent extends SerialEventSource {
  serialUnitId: string;
  from: SerialUnitStatus | null;
  to: SerialUnitStatus;
  locationId: string | null;
  orderItemId: string | null;
}

/** A serialised shipment line with how many units are assigned to (or sold on) it. */
export interface SerialisedShipmentLine {
  shipmentItemId: string;
  orderItemId: string;
  variantId: string;
  quantity: number;
  assigned: number;
}

export interface ShipmentLineFacts {
  id: string;
  orderItemId: string;
  orderId: string;
  variantId: string;
  quantity: number;
}

export interface SerialLookup extends SerialUnit {
  variant: { id: string; sku: string; product: { id: string; name: string } };
  orderItem: { id: string; order: { id: string; orderNumber: number; userId: string } } | null;
}

/** Per (variant, location) of a tracked product: units on the shelf against what the stock ledger expects there. */
export interface SerialShelfTotals {
  variantId: string;
  locationId: string;
  expected: number;
  units: number;
}

const LOOKUP_INCLUDE = {
  variant: { select: { id: true, sku: true, product: { select: { id: true, name: true } } } },
  orderItem: { select: { id: true, order: { select: { id: true, orderNumber: true, userId: true } } } },
} as const;

/** Data access for serial units and their history; writes run on the caller's transaction. */
@Injectable()
export class SerialUnitsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findTracking(db: Db, variantId: string): Promise<SerialTracking | null> {
    const variant = await db.variant.findUnique({
      where: { id: variantId },
      select: {
        product: { select: { id: true, trackSerials: true, serialFormat: true, warrantyMonths: true } },
      },
    });
    if (!variant) return null;
    const { id, ...tracking } = variant.product;
    return { productId: id, ...tracking };
  }

  /** The variants among `variantIds` whose product tracks serials. */
  async trackedVariantIds(db: Db, variantIds: readonly string[]): Promise<string[]> {
    const rows = await db.variant.findMany({
      where: { id: { in: [...variantIds] }, product: { trackSerials: true } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async findBySerials(db: Db, variantId: string, serials: readonly string[]): Promise<SerialUnit[]> {
    return db.serialUnit.findMany({ where: { variantId, serial: { in: [...serials] } } });
  }

  async createUnits(db: Db, variantId: string, locationId: string, serials: readonly string[]): Promise<SerialUnit[]> {
    return db.serialUnit.createManyAndReturn({
      data: serials.map((serial) => ({ variantId, serial, locationId, status: SerialUnitStatus.IN_STOCK })),
    });
  }

  /**
   * Moves the units matching `where` to the new state in one conditional statement (the status in `where` is the
   * guard, so a unit another request moved first is left out) and returns the units moved.
   */
  async moveUnits(
    db: Db,
    where: Prisma.SerialUnitWhereInput,
    data: Prisma.SerialUnitUncheckedUpdateManyInput,
  ): Promise<SerialUnit[]> {
    return db.serialUnit.updateManyAndReturn({ where, data });
  }

  async insertEvents(db: Db, events: NewSerialEvent[]): Promise<void> {
    if (events.length > 0) await db.serialUnitEvent.createMany({ data: events });
  }

  /** The serialised lines of a shipment, with the units assigned to (or sold on) each. */
  async findSerialisedShipmentLines(db: Db, shipmentId: string): Promise<SerialisedShipmentLine[]> {
    return db.$queryRaw<SerialisedShipmentLine[]>`
      SELECT si."id" AS "shipmentItemId", si."orderItemId", oi."variantId", si."quantity",
             (SELECT count(*)::int FROM "SerialUnit" su
              WHERE su."shipmentItemId" = si."id" AND su."status" IN ('ASSIGNED', 'SOLD')) AS "assigned"
      FROM "ShipmentItem" si
      JOIN "OrderItem" oi ON oi."id" = si."orderItemId"
      JOIN "Product" p ON p."id" = oi."productId"
      WHERE si."shipmentId" = ${shipmentId} AND p."trackSerials"
      ORDER BY si."id"`;
  }

  /** A shipment line with its order line's order and variant. */
  async findShipmentLine(db: Db, shipmentItemId: string): Promise<ShipmentLineFacts | null> {
    const item = await db.shipmentItem.findUnique({
      where: { id: shipmentItemId },
      select: {
        id: true,
        orderItemId: true,
        quantity: true,
        orderItem: { select: { orderId: true, variantId: true } },
      },
    });
    return item && { id: item.id, orderItemId: item.orderItemId, quantity: item.quantity, ...item.orderItem };
  }

  async findShipmentOrderId(db: Db, shipmentId: string): Promise<string> {
    const shipment = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { orderId: true } });
    return shipment.orderId;
  }

  async findShipmentUnits(db: Db, shipmentId: string, status: SerialUnitStatus): Promise<SerialUnit[]> {
    return db.serialUnit.findMany({ where: { status, shipmentItem: { shipmentId } } });
  }

  async findReturnRequestOrderId(db: Db, id: string): Promise<string | null> {
    const request = await db.returnRequest.findUnique({ where: { id }, select: { orderId: true } });
    return request?.orderId ?? null;
  }

  async findOrderUnits(db: Db, orderId: string, status: SerialUnitStatus): Promise<SerialUnit[]> {
    return db.serialUnit.findMany({ where: { status, orderItem: { orderId } } });
  }

  async countAssigned(db: Db, shipmentItemId: string): Promise<number> {
    return db.serialUnit.count({
      where: { shipmentItemId, status: { in: [SerialUnitStatus.ASSIGNED, SerialUnitStatus.SOLD] } },
    });
  }

  /** The order's location, where its units are picked and come back to. */
  async findOrderLocation(db: Db, orderId: string): Promise<string | null> {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { stockLocationId: true } });
    return order?.stockLocationId ?? null;
  }

  /** Warranty months of each sold unit's product in the shipment, for units not yet under warranty. */
  async findSoldUnitsForWarranty(db: Db, shipmentId: string): Promise<{ id: string; warrantyMonths: number | null }[]> {
    const units = await db.serialUnit.findMany({
      where: { status: SerialUnitStatus.SOLD, warrantyStartsAt: null, shipmentItem: { shipmentId } },
      select: { id: true, variant: { select: { product: { select: { warrantyMonths: true } } } } },
    });
    return units.map((unit) => ({ id: unit.id, warrantyMonths: unit.variant.product.warrantyMonths }));
  }

  async setWarranty(db: Db, unitId: string, startsAt: Date, endsAt: Date): Promise<void> {
    await db.serialUnit.updateMany({
      where: { id: unitId, status: SerialUnitStatus.SOLD, warrantyStartsAt: null },
      data: { warrantyStartsAt: startsAt, warrantyEndsAt: endsAt },
    });
  }

  /** Units of the variant that left on the transfer and are still in transit. */
  async findInTransit(db: Db, transferId: string, variantId: string): Promise<SerialUnit[]> {
    return db.serialUnit.findMany({
      where: {
        variantId,
        status: SerialUnitStatus.IN_TRANSIT,
        events: { some: { refType: 'StockTransfer', refId: transferId, to: SerialUnitStatus.IN_TRANSIT } },
      },
      orderBy: { serial: 'asc' },
    });
  }

  /** What decides whether the product's trackSerials flag may change (see trackSerialsChangeProblem). */
  async trackingFacts(db: Db, productId: string): Promise<TrackingFacts> {
    const [row] = await db.$queryRaw<TrackingFacts[]>`
      SELECT
        (SELECT COALESCE(sum(sl."onHand"), 0)::int FROM "StockLevel" sl
         JOIN "Variant" v ON v."id" = sl."variantId" WHERE v."productId" = ${productId}) AS "onHand",
        (SELECT COALESCE(sum(tl."quantity"), 0)::int FROM "StockTransferLine" tl
         JOIN "StockTransfer" t ON t."id" = tl."transferId"
         JOIN "Variant" v ON v."id" = tl."variantId"
         WHERE v."productId" = ${productId} AND t."status" = 'DISPATCHED') AS "inTransit",
        (SELECT count(*)::int FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId"
         WHERE oi."productId" = ${productId} AND NOT o."deleted"
           AND o."status" IN ('PLACED', 'CONFIRMED', 'IN_FULFILMENT', 'PAYMENT_REVIEW')) AS "openOrderLines",
        (SELECT count(*)::int FROM "SerialUnit" su JOIN "Variant" v ON v."id" = su."variantId"
         WHERE v."productId" = ${productId} AND su."status" IN ('IN_STOCK', 'ASSIGNED', 'IN_TRANSIT')) AS "trackedUnits"`;
    return row;
  }

  /** Units whose stored serial is one of `serials`, across variants, with their variant and order. */
  async lookup(serials: readonly string[]): Promise<SerialLookup[]> {
    return this.prisma.serialUnit.findMany({
      where: { serial: { in: [...serials] } },
      include: LOOKUP_INCLUDE,
      orderBy: [{ variantId: 'asc' }],
    });
  }

  /** Units assigned to or sold on each order line, in serial order. */
  async findByOrderItems(orderItemIds: readonly string[]): Promise<SerialUnit[]> {
    return this.prisma.serialUnit.findMany({
      where: { orderItemId: { in: [...orderItemIds] } },
      orderBy: [{ orderItemId: 'asc' }, { serial: 'asc' }],
    });
  }

  /**
   * Every (variant, location) of a tracked product whose units on the shelf (IN_STOCK + ASSIGNED) differ from what
   * the ledger expects there: onHand plus units sold online not yet in a dispatched shipment (the same rule as a
   * stock-take's expected quantity, StockTakeRepository.expectedStock).
   */
  async findShelfDisagreements(): Promise<SerialShelfTotals[]> {
    return this.prisma.$queryRaw<SerialShelfTotals[]>`
      WITH tracked AS (
        SELECT v."id" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId" WHERE p."trackSerials"
      ), awaiting_dispatch AS (
        SELECT r."variantId", r."locationId", sum(${UNDISPATCHED_RESERVED_UNITS})::int AS "quantity"
        FROM "StockReservation" r
        JOIN "Order" o ON o."id" = r."orderId"
        WHERE r."status" = 'CONSUMED' AND o."status" IN ('CONFIRMED', 'IN_FULFILMENT')
        GROUP BY r."variantId", r."locationId"
      ), on_shelf AS (
        SELECT "variantId", "locationId", count(*)::int AS "units"
        FROM "SerialUnit" WHERE "status" IN ('IN_STOCK', 'ASSIGNED')
        GROUP BY "variantId", "locationId"
      ), keys AS (
        SELECT sl."variantId", sl."locationId" FROM "StockLevel" sl
        UNION SELECT "variantId", "locationId" FROM awaiting_dispatch
        UNION SELECT "variantId", "locationId" FROM on_shelf
      ), totals AS (
        SELECT k."variantId", k."locationId",
               (COALESCE(sl."onHand", 0) + COALESCE(ad."quantity", 0))::int AS "expected",
               COALESCE(os."units", 0) AS "units"
        FROM keys k
        JOIN tracked t ON t."id" = k."variantId"
        LEFT JOIN "StockLevel" sl ON sl."variantId" = k."variantId" AND sl."locationId" = k."locationId"
        LEFT JOIN awaiting_dispatch ad ON ad."variantId" = k."variantId" AND ad."locationId" = k."locationId"
        LEFT JOIN on_shelf os ON os."variantId" = k."variantId" AND os."locationId" = k."locationId"
      )
      SELECT * FROM totals WHERE "expected" <> "units" ORDER BY "variantId", "locationId"`;
  }
}
