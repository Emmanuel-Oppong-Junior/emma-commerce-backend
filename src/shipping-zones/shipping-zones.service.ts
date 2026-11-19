import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ShippingZone } from '../generated/prisma/client';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { Decimal } from '@prisma/client/runtime/client';
import { AddressesService } from '../addresses/addresses.service';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

const AUDITED_ZONE_FIELDS = ['name', 'cities', 'fee', 'isActive'] as const satisfies readonly (keyof ShippingZone)[];

/** Cities are compared case-insensitively, ignoring surrounding and repeated whitespace. */
export function normaliseCity(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

@Injectable()
export class ShippingZonesService {
  constructor(
    private readonly repository: ShippingZonesRepository,
    private readonly addressesService: AddressesService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateShippingZoneInput, actorId: string): Promise<ShippingZone> {
    const cities = this.normaliseCities(input.cities);
    await this.ensureCitiesNotInOtherZones(cities);
    return this.auditService.record(
      (tx) =>
        this.repository.create({ name: input.name, cities, fee: input.fee, isActive: input.isActive ?? true }, tx),
      (zone) => ({
        entity: 'ShippingZone',
        entityId: zone.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(zone, AUDITED_ZONE_FIELDS) },
      }),
    );
  }

  async update(id: string, input: UpdateShippingZoneInput, actorId: string): Promise<ShippingZone> {
    const existing = await this.findOne(id);
    const data: Record<string, unknown> = { ...input };
    if (input.cities) {
      const cities = this.normaliseCities(input.cities);
      await this.ensureCitiesNotInOtherZones(cities, id);
      data.cities = cities;
    }
    return this.auditService.record(
      (tx) => this.repository.update(id, data, tx),
      (updated) => ({
        entity: 'ShippingZone',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_ZONE_FIELDS) },
      }),
    );
  }

  async delete(id: string, actorId: string): Promise<ShippingZone> {
    return this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (deleted) => ({
        entity: 'ShippingZone',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_ZONE_FIELDS) },
      }),
    );
  }

  async findAll(): Promise<ShippingZone[]> {
    return this.repository.findAll();
  }

  async findActive(): Promise<ShippingZone[]> {
    return this.repository.findActive();
  }

  async findOne(id: string): Promise<ShippingZone> {
    const zone = await this.repository.findById(id);
    if (!zone) throw new NotFoundException(`Shipping zone "${id}" not found`);
    return zone;
  }

  /**
   * Returns the shipping fee of the active zone covering the city.
   * Throws BadRequestException when no active zone covers it: delivery there is not offered.
   */
  async getFeeForCity(city: string): Promise<Decimal> {
    const zone = await this.repository.findByCity(normaliseCity(city));
    if (!zone) {
      throw new BadRequestException(`Delivery is not available to city "${city}": no active shipping zone covers it`);
    }
    return zone.fee;
  }

  /**
   * Returns the shipping fee for a user's saved address.
   * Verifies the address belongs to the requesting user before looking up the fee.
   */
  async getFeeForAddress(addressId: string, userId: string): Promise<Decimal> {
    const address = await this.addressesService.getAddress(userId, addressId);
    return this.getFeeForCity(address.city);
  }

  private normaliseCities(cities: string[]): string[] {
    const normalised = cities.map(normaliseCity);
    if (normalised.some((city) => city === '')) {
      throw new BadRequestException('Shipping zone cities must not be blank');
    }
    return [...new Set(normalised)];
  }

  private async ensureCitiesNotInOtherZones(cities: string[], zoneId?: string): Promise<void> {
    if (cities.length === 0) return;
    const overlapping = await this.repository.findCoveringAnyCity(cities, zoneId);
    if (overlapping.length === 0) return;
    const taken = overlapping.flatMap((zone) =>
      zone.cities.filter((city) => cities.includes(city)).map((city) => `"${city}" (zone "${zone.name}")`),
    );
    throw new ConflictException(`Cities already covered by another shipping zone: ${taken.join(', ')}`);
  }
}
