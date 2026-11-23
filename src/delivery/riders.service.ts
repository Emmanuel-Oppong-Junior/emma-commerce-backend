import { Injectable, NotFoundException } from '@nestjs/common';
import { ShipmentStatus } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { ShipmentsService } from '../order/shipments.service';
import { ShipmentsRepository } from '../order/shipments.repository';
import { DeliveryRider, RiderDelivery } from './entities/rider-delivery.entity';
import { assertRider, decideAssignment, decideUnassignment } from './rider-assignment';
import { dayRange, OPEN_DELIVERY_STATUSES, toRiderDelivery } from './rider-delivery';
import { RidersRepository } from './riders.repository';

export interface MyDeliveriesQuery {
  status?: ShipmentStatus[];
  date?: string;
  first: number;
}

/**
 * Riders (P5-C.1): staff with order.fulfil assign a delivery shipment to a rider (rider-assignment.ts); riders see and
 * step only the shipments assigned to them. Every assignment runs with the shipment's order locked, the lock every
 * fulfilment step takes, and is audited.
 */
@Injectable()
export class RidersService {
  constructor(
    private readonly repository: RidersRepository,
    private readonly shipments: ShipmentsService,
    private readonly shipmentsRepository: ShipmentsRepository,
    private readonly auditService: AuditService,
  ) {}

  findRiders(): Promise<DeliveryRider[]> {
    return this.repository.findRiders();
  }

  async assign(shipmentId: string, riderId: string, actorId: string, reason?: string) {
    await this.repository.runTransaction(async (tx) => {
      const { order, shipment } = await this.shipments.lockShipment(tx, shipmentId);
      if (!decideAssignment(order.fulfillmentType, shipment, riderId, reason)) return;
      assertRider(await this.repository.findRiderFacts(tx, riderId), riderId);
      await this.repository.setRider(tx, shipmentId, riderId);
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipmentId,
          action: 'RIDER_ASSIGN',
          userId: actorId,
          details: {
            orderId: order.id,
            status: shipment.status,
            from: shipment.riderId,
            to: riderId,
            ...(reason && { reason }),
          },
        },
        tx,
      );
    });
    return this.shipmentsRepository.findWithHistory(shipmentId);
  }

  async unassign(shipmentId: string, actorId: string, reason?: string) {
    await this.repository.runTransaction(async (tx) => {
      const { order, shipment } = await this.shipments.lockShipment(tx, shipmentId);
      if (!decideUnassignment(order.fulfillmentType, shipment, reason)) return;
      await this.repository.setRider(tx, shipmentId, null);
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipmentId,
          action: 'RIDER_UNASSIGN',
          userId: actorId,
          details: { orderId: order.id, status: shipment.status, from: shipment.riderId, ...(reason && { reason }) },
        },
        tx,
      );
    });
    return this.shipmentsRepository.findWithHistory(shipmentId);
  }

  async myDeliveries(riderId: string, query: MyDeliveriesQuery): Promise<RiderDelivery[]> {
    const day = query.date ? dayRange(query.date) : null;
    const statuses = query.status?.length ? query.status : OPEN_DELIVERY_STATUSES;
    const rows = await this.repository.findDeliveries(riderId, statuses, day, query.first);
    return rows.map(toRiderDelivery);
  }

  /** NOT_FOUND unless the shipment is assigned to the rider, so riders learn nothing about other shipments. */
  async myDelivery(riderId: string, shipmentId: string): Promise<RiderDelivery> {
    const row = await this.repository.findDelivery(riderId, shipmentId);
    if (!row) throw new NotFoundException(`Shipment "${shipmentId}" not found`);
    return toRiderDelivery(row);
  }

  async startDelivery(riderId: string, shipmentId: string): Promise<RiderDelivery> {
    await this.shipments.moveAsRider(shipmentId, ShipmentStatus.OUT_FOR_DELIVERY, riderId);
    return this.myDelivery(riderId, shipmentId);
  }

  async failDelivery(riderId: string, shipmentId: string, reason: string): Promise<RiderDelivery> {
    await this.shipments.moveAsRider(shipmentId, ShipmentStatus.FAILED_DELIVERY, riderId, reason);
    return this.myDelivery(riderId, shipmentId);
  }
}
