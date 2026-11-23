import { Prisma } from '../generated/prisma/client';

/**
 * Units of a consumed reservation (a `StockReservation` aliased `r`) still in the shop: its quantity less its order
 * line's units in shipments that have left (dispatched, delivered, failed or returned; not pending, picking, packed or
 * cancelled). With split shipments (P5-B.1) part of an order can be out while the rest is on the shelf, so this is
 * counted per order line, not per order.
 */
export const UNDISPATCHED_RESERVED_UNITS = Prisma.sql`GREATEST(r."quantity" - COALESCE((
  SELECT sum(si."quantity") FROM "ShipmentItem" si JOIN "Shipment" s ON s."id" = si."shipmentId"
  WHERE si."orderItemId" = r."orderItemId" AND s."status" NOT IN ('PENDING', 'PICKING', 'PACKED', 'CANCELLED')
), 0), 0)`;
