import { Injectable, NotFoundException } from '@nestjs/common';
import { PickupLocation, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PickupLocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.PickupLocationCreateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PickupLocation> {
    return db.pickupLocation.create({ data });
  }

  async findById(id: string): Promise<PickupLocation | null> {
    return this.prisma.pickupLocation.findUnique({ where: { id } });
  }

  async findAll(): Promise<PickupLocation[]> {
    return this.prisma.pickupLocation.findMany({ orderBy: { name: 'asc' } });
  }

  async findActive(): Promise<PickupLocation[]> {
    return this.prisma.pickupLocation.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  async update(
    id: string,
    data: Prisma.PickupLocationUpdateInput,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PickupLocation> {
    try {
      return await db.pickupLocation.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Pickup location "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient = this.prisma): Promise<PickupLocation> {
    try {
      return await db.pickupLocation.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Pickup location "${id}" not found`);
      }
      throw e;
    }
  }
}
