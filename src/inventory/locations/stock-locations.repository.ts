import { Injectable } from '@nestjs/common';
import { Prisma, StockLocation, StockLocationType } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FulfilmentListEntry, StockAtLocation } from '../fulfilment-location';
import { SERVING_LOCATION_SQL } from './serving-locations';
import { expiredLotUnitsSql } from '../lots/lot-stock.repository';

type Db = Prisma.TransactionClient;

/** Where an order goes: a delivery zone, or a pickup point. */
export type FulfilmentTarget = { shippingZoneId: string } | { pickupLocationId: string };

export interface LocationStockLevel extends StockAtLocation {
  locationName: string;
}

/** Stock locations, the fulfilment lists of shipping zones and pickup points, and per-location stock reads. */
@Injectable()
export class StockLocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<StockLocation[]> {
    return this.prisma.stockLocation.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  }

  async findById(id: string, db: Db = this.prisma): Promise<StockLocation | null> {
    return db.stockLocation.findUnique({ where: { id } });
  }

  async findByIds(ids: string[], db: Db = this.prisma): Promise<StockLocation[]> {
    return db.stockLocation.findMany({ where: { id: { in: ids } } });
  }

  async storeId(db: Db): Promise<string> {
    const store = await db.store.findFirst({ where: { singleton: true }, select: { id: true } });
    if (!store) throw new Error('No store row exists; apply the database migrations');
    return store.id;
  }

  async create(
    db: Db,
    data: { storeId: string; name: string; type: StockLocationType; isActive: boolean },
  ): Promise<StockLocation> {
    return db.stockLocation.create({ data });
  }

  async update(db: Db, id: string, data: Prisma.StockLocationUpdateInput): Promise<StockLocation> {
    return db.stockLocation.update({ where: { id }, data });
  }

  /** Takes the default flag off the current default, so another location can take it (one default per store). */
  async clearDefault(db: Db): Promise<void> {
    await db.stockLocation.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  /** Whether stock ever moved at the location or an order or transfer refers to it. */
  async hasHistory(db: Db, id: string): Promise<boolean> {
    const [movements, reservations, orders, transfers] = await Promise.all([
      db.stockMovement.count({ where: { locationId: id } }),
      db.stockReservation.count({ where: { locationId: id } }),
      db.order.count({ where: { stockLocationId: id } }),
      db.stockTransfer.count({ where: { OR: [{ fromLocationId: id }, { toLocationId: id }] } }),
    ]);
    return movements + reservations + orders + transfers > 0;
  }

  /** Removes the location with its (empty) stock levels; fulfilment list entries go with it. */
  async delete(db: Db, id: string): Promise<void> {
    await db.stockLevel.deleteMany({ where: { locationId: id, onHand: 0, reserved: 0 } });
    await db.stockLocation.delete({ where: { id } });
  }

  async fulfilmentList(target: FulfilmentTarget, db: Db = this.prisma): Promise<FulfilmentListEntry[]> {
    const select = { locationId: true, location: { select: { isActive: true } } } as const;
    const rows =
      'shippingZoneId' in target
        ? await db.shippingZoneStockLocation.findMany({
            where: { shippingZoneId: target.shippingZoneId },
            orderBy: { priority: 'asc' },
            select,
          })
        : await db.pickupLocationStockLocation.findMany({
            where: { pickupLocationId: target.pickupLocationId },
            orderBy: { priority: 'asc' },
            select,
          });
    return rows.map((row) => ({ locationId: row.locationId, isActive: row.location.isActive }));
  }

  /** The configured locations of the target, in priority order (inactive ones included). */
  async fulfilmentLocations(target: FulfilmentTarget): Promise<StockLocation[]> {
    const include = { location: true } as const;
    const rows =
      'shippingZoneId' in target
        ? await this.prisma.shippingZoneStockLocation.findMany({
            where: { shippingZoneId: target.shippingZoneId },
            orderBy: { priority: 'asc' },
            include,
          })
        : await this.prisma.pickupLocationStockLocation.findMany({
            where: { pickupLocationId: target.pickupLocationId },
            orderBy: { priority: 'asc' },
            include,
          });
    return rows.map((row) => row.location);
  }

  async targetExists(db: Db, target: FulfilmentTarget): Promise<boolean> {
    return 'shippingZoneId' in target
      ? (await db.shippingZone.count({ where: { id: target.shippingZoneId } })) > 0
      : (await db.pickupLocation.count({ where: { id: target.pickupLocationId } })) > 0;
  }

  /** Replaces the target's list with `locationIds`, the first one tried first. */
  async replaceFulfilmentList(db: Db, target: FulfilmentTarget, locationIds: string[]): Promise<void> {
    if ('shippingZoneId' in target) {
      await db.shippingZoneStockLocation.deleteMany({ where: { shippingZoneId: target.shippingZoneId } });
      await db.shippingZoneStockLocation.createMany({
        data: locationIds.map((locationId, priority) => ({
          shippingZoneId: target.shippingZoneId,
          locationId,
          priority,
        })),
      });
    } else {
      await db.pickupLocationStockLocation.deleteMany({ where: { pickupLocationId: target.pickupLocationId } });
      await db.pickupLocationStockLocation.createMany({
        data: locationIds.map((locationId, priority) => ({
          pickupLocationId: target.pickupLocationId,
          locationId,
          priority,
        })),
      });
    }
  }

  /**
   * Locks the stock levels of the variants at the locations (in a fixed order, so concurrent placements cannot
   * deadlock) and returns them; a variant with no level at a location is absent. onHand leaves out the units of
   * expired lots, which cannot be sold (P4-C.1).
   */
  async lockLevels(tx: Db, variantIds: string[], locationIds: string[]): Promise<StockAtLocation[]> {
    if (variantIds.length === 0 || locationIds.length === 0) return [];
    return tx.$queryRaw<StockAtLocation[]>`
      SELECT sl."variantId", sl."locationId", sl."onHand" - ${expiredLotUnitsSql('sl', new Date())} AS "onHand",
             sl."reserved"
      FROM "StockLevel" sl
      WHERE sl."variantId" IN (${Prisma.join(variantIds)}) AND sl."locationId" IN (${Prisma.join(locationIds)})
      ORDER BY sl."variantId", sl."locationId"
      FOR UPDATE OF sl`;
  }

  /**
   * For each variant, the most available at any one location that serves customers (see SERVING_LOCATION), units of
   * expired lots left out.
   */
  async findSellable(variantIds: readonly string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ variantId: string; sellable: number }[]>`
      SELECT sl."variantId",
             GREATEST(max(sl."onHand" - sl."reserved" - ${expiredLotUnitsSql('sl', new Date())}), 0)::int AS sellable
      FROM "StockLevel" sl JOIN "StockLocation" l ON l."id" = sl."locationId"
      WHERE sl."variantId" IN (${Prisma.join([...variantIds])}) AND ${SERVING_LOCATION_SQL}
      GROUP BY sl."variantId"`;
    return new Map(rows.map((row) => [row.variantId, row.sellable]));
  }

  /** Every stock level of the variants, per location, with the location's name. */
  async findLevelsByLocation(variantIds: readonly string[]): Promise<LocationStockLevel[]> {
    const rows = await this.prisma.stockLevel.findMany({
      where: { variantId: { in: [...variantIds] } },
      select: { variantId: true, locationId: true, onHand: true, reserved: true, location: { select: { name: true } } },
      orderBy: [{ location: { isDefault: 'desc' } }, { location: { name: 'asc' } }],
    });
    return rows.map(({ location, ...level }) => ({ ...level, locationName: location.name }));
  }
}
