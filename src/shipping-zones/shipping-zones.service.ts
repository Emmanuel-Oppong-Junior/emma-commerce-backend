import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ShippingZone } from '@prisma/client';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { Decimal } from '@prisma/client/runtime/library';
import { AddressesService } from '../addresses/addresses.service';

/** Cities are compared case-insensitively, ignoring surrounding and repeated whitespace. */
export function normaliseCity(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

@Injectable()
export class ShippingZonesService {
  constructor(
    private readonly repository: ShippingZonesRepository,
    private readonly addressesService: AddressesService,
  ) {}

  async create(input: CreateShippingZoneInput): Promise<ShippingZone> {
    const cities = this.normaliseCities(input.cities);
    await this.ensureCitiesNotInOtherZones(cities);
    return this.repository.create({
      name: input.name,
      cities,
      fee: input.fee,
      isActive: input.isActive ?? true,
    });
  }

  async update(id: string, input: UpdateShippingZoneInput): Promise<ShippingZone> {
    const data: Record<string, unknown> = { ...input };
    if (input.cities) {
      const cities = this.normaliseCities(input.cities);
      await this.ensureCitiesNotInOtherZones(cities, id);
      data.cities = cities;
    }
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<ShippingZone> {
    return this.repository.delete(id);
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
    return zone.fee as unknown as Decimal;
  }

  /**
   * Returns the shipping fee for a user's saved address.
   * Verifies the address belongs to the requesting user before looking up the fee.
   */
  async getFeeForAddress(addressId: string, userId: string): Promise<number> {
    const address = await this.addressesService.getAddress(userId, addressId);
    const fee = await this.getFeeForCity(address.city);
    return Number(fee);
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
