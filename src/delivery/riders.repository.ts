import { Injectable } from '@nestjs/common';
import { Prisma, ShipmentStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OWNER_ROLE_KEY } from '../iam/authorization/permissions';
import { DeliveryRider } from './entities/rider-delivery.entity';
import { RIDE_PERMISSION, RiderFacts } from './rider-assignment';
import { RIDER_DELIVERY_SELECT, RiderDeliveryRow } from './rider-delivery';

type Tx = Prisma.TransactionClient;

const RIDER_SELECT = { id: true, name: true, phoneNumber: true } satisfies Prisma.UserSelect;

/** Data access for riders and their assigned shipments (P5-C.1). */
@Injectable()
export class RidersRepository {
  constructor(private readonly prisma: PrismaService) {}

  runTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async findRiderFacts(tx: Tx, userId: string): Promise<RiderFacts | null> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        storeMemberships: { select: { role: { select: { key: true, permissions: true } } }, take: 1 },
      },
    });
    if (!user) return null;
    return { isActive: user.isActive, role: user.storeMemberships[0]?.role ?? null };
  }

  /** Active riders (isRider), by name. */
  async findRiders(): Promise<DeliveryRider[]> {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        storeMemberships: {
          some: { role: { permissions: { has: RIDE_PERMISSION }, key: { not: OWNER_ROLE_KEY } } },
        },
      },
      select: RIDER_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async findRidersByIds(ids: readonly string[]): Promise<DeliveryRider[]> {
    return this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: RIDER_SELECT });
  }

  /** Sets (or clears) the shipment's rider. Call with the shipment's order locked. */
  async setRider(tx: Tx, shipmentId: string, riderId: string | null): Promise<void> {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { riderId, assignedAt: riderId ? new Date() : null },
    });
  }

  async findDeliveries(
    riderId: string,
    statuses: ShipmentStatus[],
    day: { from: Date; to: Date } | null,
    take: number,
  ): Promise<RiderDeliveryRow[]> {
    const within = day && { gte: day.from, lt: day.to };
    return this.prisma.shipment.findMany({
      where: {
        riderId,
        status: { in: statuses },
        ...(within && { OR: [{ assignedAt: within }, { dispatchedAt: within }, { deliveredAt: within }] }),
      },
      select: RIDER_DELIVERY_SELECT,
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  async findDelivery(riderId: string, shipmentId: string): Promise<RiderDeliveryRow | null> {
    return this.prisma.shipment.findFirst({ where: { id: shipmentId, riderId }, select: RIDER_DELIVERY_SELECT });
  }
}
