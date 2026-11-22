import { Prisma } from '../../generated/prisma/client';

// The locations whose stock customers can buy when the delivery target is not known yet (product pages, cart): the
// active ones that fulfil some shipping zone or pickup point, plus the default, which serves every empty list. The
// Prisma filter and the SQL condition say the same thing and must change together.

export const SERVING_LOCATION: Prisma.StockLocationWhereInput = {
  isActive: true,
  OR: [{ isDefault: true }, { shippingZones: { some: {} } }, { pickupLocations: { some: {} } }],
};

/** SQL condition on a "StockLocation" row aliased `l`. */
export const SERVING_LOCATION_SQL = Prisma.sql`l."isActive" AND (
  l."isDefault"
  OR EXISTS (SELECT 1 FROM "ShippingZoneStockLocation" z WHERE z."locationId" = l."id")
  OR EXISTS (SELECT 1 FROM "PickupLocationStockLocation" p WHERE p."locationId" = l."id")
)`;
