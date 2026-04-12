import { Injectable, NotFoundException } from '@nestjs/common';
import { ShippingZone } from '@prisma/client';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { Decimal } from '@prisma/client/runtime/library';

const DEFAULT_SHIPPING_FEE = new Decimal('0');

@Injectable()
export class ShippingZonesService {
  constructor(private readonly repository: ShippingZonesRepository) {}

  async create(input: CreateShippingZoneInput): Promise<ShippingZone> {
    return this.repository.create({
      name: input.name,
      cities: input.cities.map((c) => c.trim().toLowerCase()),
      fee: input.fee,
      isActive: input.isActive ?? true,
    });
  }

  async update(id: string, input: UpdateShippingZoneInput): Promise<ShippingZone> {
    const data: Record<string, unknown> = { ...input };
    if (input.cities) {
      data.cities = input.cities.map((c) => c.trim().toLowerCase());
    }
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<ShippingZone> {
    return this.repository.delete(id);
  }

  async findAll(): Promise<ShippingZone[]> {
    return this.repository.findAll();
  }

  async findOne(id: string): Promise<ShippingZone> {
    const zone = await this.repository.findById(id);
    if (!zone) throw new NotFoundException(`Shipping zone "${id}" not found`);
    return zone;
  }

  /**
   * Returns the shipping fee for the given city.
   * Falls back to 0 (free shipping) if no active zone covers the city.
   */
  async getFeeForCity(city: string): Promise<Decimal> {
    const zone = await this.repository.findByCity(city);
    return zone ? (zone.fee as unknown as Decimal) : DEFAULT_SHIPPING_FEE;
  }
}
