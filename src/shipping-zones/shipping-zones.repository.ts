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

  async findByCity(city: string): Promise<ShippingZone | null> {
    const normalised = city.trim().toLowerCase();
    return this.prisma.shippingZone.findFirst({
      where: { isActive: true, cities: { has: normalised } },
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
