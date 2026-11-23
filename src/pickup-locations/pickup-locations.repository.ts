import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpeningHours } from './opening-hours';

const WITH_HOURS = {
  openingHours: { orderBy: { weekday: 'asc' } },
} satisfies Prisma.PickupLocationInclude;

export type PickupLocationWithHours = Prisma.PickupLocationGetPayload<{ include: typeof WITH_HOURS }>;

export type PickupLocationData = Omit<Prisma.PickupLocationUncheckedCreateInput, 'id' | 'openingHours'>;

@Injectable()
export class PickupLocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: PickupLocationData,
    hours: readonly OpeningHours[],
    db: Prisma.TransactionClient,
  ): Promise<PickupLocationWithHours> {
    return db.pickupLocation.create({
      data: { ...data, openingHours: { create: [...hours] } },
      include: WITH_HOURS,
    });
  }

  async findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<PickupLocationWithHours | null> {
    return db.pickupLocation.findUnique({ where: { id }, include: WITH_HOURS });
  }

  async findAll(): Promise<PickupLocationWithHours[]> {
    return this.prisma.pickupLocation.findMany({ orderBy: { name: 'asc' }, include: WITH_HOURS });
  }

  async findActive(): Promise<PickupLocationWithHours[]> {
    return this.prisma.pickupLocation.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: WITH_HOURS,
    });
  }

  async update(
    id: string,
    data: Partial<PickupLocationData>,
    hours: readonly OpeningHours[] | undefined,
    db: Prisma.TransactionClient,
  ): Promise<PickupLocationWithHours> {
    try {
      if (hours) {
        await db.pickupOpeningHours.deleteMany({ where: { pickupLocationId: id } });
        await db.pickupOpeningHours.createMany({ data: hours.map((day) => ({ ...day, pickupLocationId: id })) });
      }
      return await db.pickupLocation.update({ where: { id }, data, include: WITH_HOURS });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Pickup location "${id}" not found`);
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient): Promise<PickupLocationWithHours> {
    try {
      return await db.pickupLocation.delete({ where: { id }, include: WITH_HOURS });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Pickup location "${id}" not found`);
      }
      throw e;
    }
  }
}
