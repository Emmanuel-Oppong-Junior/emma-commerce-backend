import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ShippingZone } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ShippingZonesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.ShippingZoneCreateInput): Promise<ShippingZone> {
    try {
      return await this.prisma.shippingZone.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Shipping zone "${data.name}" already exists`);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<ShippingZone | null> {
    return this.prisma.shippingZone.findUnique({ where: { id } });
  }

  async findAll(): Promise<ShippingZone[]> {
    return this.prisma.shippingZone.findMany({ orderBy: { name: 'asc' } });
  }

  async findActive(): Promise<ShippingZone[]> {
    return this.prisma.shippingZone.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  /** Expects an already-normalised city. The orderBy keeps the result stable if legacy rows overlap. */
  async findByCity(city: string): Promise<ShippingZone | null> {
    return this.prisma.shippingZone.findFirst({
      where: { isActive: true, cities: { has: city } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Every zone, active or not, that lists any of the cities; `excludeId` skips the zone being updated. */
  async findCoveringAnyCity(cities: string[], excludeId?: string): Promise<ShippingZone[]> {
    return this.prisma.shippingZone.findMany({
      where: { cities: { hasSome: cities }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  async update(id: string, data: Prisma.ShippingZoneUpdateInput): Promise<ShippingZone> {
    try {
      return await this.prisma.shippingZone.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Shipping zone "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<ShippingZone> {
    try {
      return await this.prisma.shippingZone.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Shipping zone "${id}" not found`);
      }
      throw e;
    }
  }
}
