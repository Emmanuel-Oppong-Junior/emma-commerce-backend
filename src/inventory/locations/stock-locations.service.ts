import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockLocation, StockLocationType } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldChanges } from '../../commons/audit.service';
import { StockLedgerRepository } from '../stock-ledger.repository';
import { chooseFulfilmentLocation, firstUnfillableVariant, fulfilmentCandidates } from '../fulfilment-location';
import { FulfilmentTarget, StockLocationsRepository } from './stock-locations.repository';

type Db = Prisma.TransactionClient;

export const MAX_FULFILMENT_LOCATIONS = 20;

export interface CreateStockLocation {
  name: string;
  type?: StockLocationType;
  isActive?: boolean;
}

export interface UpdateStockLocation {
  name?: string;
  type?: StockLocationType;
  isActive?: boolean;
  isDefault?: boolean;
}

/**
 * Stock locations and which of them fulfil each shipping zone and pickup point (P4-A.1). The default location is
 * always active and serves every empty fulfilment list. Deactivating a location stops new orders being fulfilled
 * from it and hides its stock from customers; orders already reserved there are consumed, released and restocked
 * there as usual.
 */
@Injectable()
export class StockLocationsService {
  constructor(
    private readonly repository: StockLocationsRepository,
    private readonly ledgerRepository: StockLedgerRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<StockLocation[]> {
    return this.repository.findAll();
  }

  async findOne(id: string): Promise<StockLocation> {
    const location = await this.repository.findById(id);
    if (!location) throw new NotFoundException(`Stock location "${id}" not found`);
    return location;
  }

  async create(input: CreateStockLocation, actorId: string): Promise<StockLocation> {
    return this.prisma.$transaction(async (tx) => {
      const location = await this.repository.create(tx, {
        storeId: await this.repository.storeId(tx),
        name: input.name,
        type: input.type ?? StockLocationType.WAREHOUSE,
        isActive: input.isActive ?? true,
      });
      await this.audit.log(
        {
          entity: 'StockLocation',
          entityId: location.id,
          action: 'CREATE',
          userId: actorId,
          details: { name: location.name, type: location.type, isActive: location.isActive },
        },
        tx,
      );
      return location;
    });
  }

  /**
   * Renames, retypes, (de)activates a location or makes it the default (taking the flag off the old one).
   * @throws BadRequestException when deactivating the default, unsetting the default directly, or making an inactive
   *   location the default.
   */
  async update(id: string, input: UpdateStockLocation, actorId: string): Promise<StockLocation> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.repository.findById(id, tx);
      if (!before) throw new NotFoundException(`Stock location "${id}" not found`);
      const isActive = input.isActive ?? before.isActive;
      if (input.isDefault === false && before.isDefault) {
        throw new BadRequestException('Make another location the default instead of unsetting this one');
      }
      const becomesDefault = input.isDefault === true && !before.isDefault;
      if ((before.isDefault || becomesDefault) && !isActive) {
        throw new BadRequestException(
          `The default location "${before.name}" must stay active; make another location the default first`,
        );
      }
      if (becomesDefault) await this.repository.clearDefault(tx);
      const after = await this.repository.update(tx, id, {
        name: input.name,
        type: input.type,
        isActive: input.isActive,
        ...(becomesDefault && { isDefault: true }),
      });
      await this.audit.log(
        {
          entity: 'StockLocation',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: { changes: fieldChanges(before, after, ['name', 'type', 'isActive', 'isDefault']) },
        },
        tx,
      );
      return after;
    });
  }

  /**
   * Deletes a location that never held stock. A location with stock history (movements, reservations, orders,
   * transfers) is kept for the ledger: deactivate it instead.
   * @throws ConflictException for the default location or one with history.
   */
  async delete(id: string, actorId: string): Promise<StockLocation> {
    return this.prisma.$transaction(async (tx) => {
      const location = await this.repository.findById(id, tx);
      if (!location) throw new NotFoundException(`Stock location "${id}" not found`);
      if (location.isDefault) {
        throw new ConflictException(`"${location.name}" is the default location; make another the default first`);
      }
      if (await this.repository.hasHistory(tx, id)) {
        throw new ConflictException(
          `"${location.name}" has stock history and cannot be deleted; deactivate it instead`,
        );
      }
      await this.repository.delete(tx, id);
      await this.audit.log(
        { entity: 'StockLocation', entityId: id, action: 'DELETE', userId: actorId, details: { name: location.name } },
        tx,
      );
      return location;
    });
  }

  /** The locations configured for a shipping zone or pickup point, in priority order (inactive ones included). */
  async fulfilmentLocations(target: FulfilmentTarget): Promise<StockLocation[]> {
    return this.repository.fulfilmentLocations(target);
  }

  /**
   * Replaces the ordered list of locations that fulfil a shipping zone or pickup point; an empty list means the
   * default location.
   */
  async setFulfilmentLocations(
    target: FulfilmentTarget,
    locationIds: string[],
    actorId: string,
  ): Promise<StockLocation[]> {
    if (new Set(locationIds).size !== locationIds.length) {
      throw new BadRequestException('A location can appear only once in a fulfilment list');
    }
    if (locationIds.length > MAX_FULFILMENT_LOCATIONS) {
      throw new BadRequestException(`A fulfilment list holds at most ${MAX_FULFILMENT_LOCATIONS} locations`);
    }
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.repository.targetExists(tx, target))) {
        const [kind, id] =
          'shippingZoneId' in target
            ? ['Shipping zone', target.shippingZoneId]
            : ['Pickup location', target.pickupLocationId];
        throw new NotFoundException(`${kind} "${id}" not found`);
      }
      const found = new Set((await this.repository.findByIds(locationIds, tx)).map((location) => location.id));
      const missing = locationIds.find((locationId) => !found.has(locationId));
      if (missing) throw new NotFoundException(`Stock location "${missing}" not found`);
      const before = (await this.repository.fulfilmentList(target, tx)).map((entry) => entry.locationId);
      await this.repository.replaceFulfilmentList(tx, target, locationIds);
      await this.audit.log(
        {
          entity: 'shippingZoneId' in target ? 'ShippingZone' : 'PickupLocation',
          entityId: 'shippingZoneId' in target ? target.shippingZoneId : target.pickupLocationId,
          action: 'UPDATE',
          userId: actorId,
          details: { fulfilmentLocations: { from: before, to: locationIds } },
        },
        tx,
      );
    });
    return this.repository.fulfilmentLocations(target);
  }

  /** The locations an order to the target may be fulfilled from, in the order they are tried. */
  async candidatesFor(target: FulfilmentTarget, db: Db = this.prisma): Promise<string[]> {
    const list = await this.repository.fulfilmentList(target, db);
    return fulfilmentCandidates(list, await this.ledgerRepository.defaultLocationId(db));
  }

  /**
   * Locks the lines' stock levels at the candidates and picks the first candidate that can fill every line. With the
   * levels locked until the order's transaction ends, a concurrent order cannot take the stock between this choice
   * and the reservations, so a lost race shows here (next candidate, or none) rather than as a refused reservation.
   * When none can, `shortVariantId` names the first variant no candidate holds enough of (null: each variant is in
   * stock somewhere, just not all at one location).
   */
  async lockFulfilmentLocation(
    tx: Db,
    candidates: string[],
    lines: { variantId: string; quantity: number }[],
  ): Promise<{ locationId: string } | { locationId: null; shortVariantId: string | null }> {
    const variantIds = [...new Set(lines.map((line) => line.variantId))].sort();
    const levels = await this.repository.lockLevels(tx, variantIds, candidates);
    const locationId = chooseFulfilmentLocation(candidates, lines, levels);
    if (locationId) return { locationId };
    return { locationId: null, shortVariantId: firstUnfillableVariant(candidates, lines, levels) };
  }
}
