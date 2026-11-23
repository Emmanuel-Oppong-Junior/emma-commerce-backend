import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Order, OrderItem, Prisma, ShipmentStatus } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { SerialLookup } from '../inventory/serials/serial-units.repository';
import { FULFILLABLE_STATUSES } from './order-status';
import { OrdersRepository } from './order.repository';
import { ShipmentsRepository } from './shipments.repository';

/** Serials are assigned while the goods are being picked or packed, before dispatch. */
export const SERIAL_ASSIGNMENT_STATUSES: ShipmentStatus[] = [ShipmentStatus.PICKING, ShipmentStatus.PACKED];

type Assignment = 'assign' | 'unassign';

/**
 * Serial units at pick (P4-D.1, per shipment since P5-B.1): staff (order.fulfil) assign the units they picked to each
 * serial-tracked shipment line, or take them off again, while that shipment is PICKING or PACKED. Runs with the order
 * row locked, like every fulfilment step, and is audited. Dispatch of the shipment then requires every serialised line
 * of it to be fully assigned.
 */
@Injectable()
export class OrderSerialsService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly shipmentsRepository: ShipmentsRepository,
    private readonly serialUnits: SerialUnitsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * @throws NotFoundException for an unknown shipment line or deleted order; ConflictException when the order is not
   * being fulfilled or the shipment is not PICKING or PACKED; and what SerialUnitsService.assign throws.
   */
  async assign(shipmentItemId: string, serials: string[], actorId: string): Promise<Order & { items: OrderItem[] }> {
    return this.change('assign', shipmentItemId, serials, actorId);
  }

  /** As assign; each serial must be assigned to this shipment line. */
  async unassign(shipmentItemId: string, serials: string[], actorId: string): Promise<Order & { items: OrderItem[] }> {
    return this.change('unassign', shipmentItemId, serials, actorId);
  }

  async lookup(serial: string): Promise<SerialLookup[]> {
    return this.serialUnits.lookup(serial);
  }

  private async change(
    kind: Assignment,
    shipmentItemId: string,
    serials: string[],
    actorId: string,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const item = await this.shipmentsRepository.findItem(tx, shipmentItemId);
      if (!item) throw new NotFoundException(`Shipment line "${shipmentItemId}" not found`);
      const orderId = item.shipment.orderId;
      await this.assertAssignable(tx, orderId, item.shipmentId);
      const source = { actorId, refType: 'Order', refId: orderId };
      const changed =
        kind === 'assign'
          ? await this.serialUnits.assign(tx, shipmentItemId, serials, source)
          : await this.serialUnits.unassign(tx, shipmentItemId, serials, source);
      await this.auditService.log(
        {
          entity: 'OrderItem',
          entityId: item.orderItemId,
          action: 'UPDATE',
          userId: actorId,
          details: {
            change: kind === 'assign' ? 'SERIALS_ASSIGNED' : 'SERIALS_UNASSIGNED',
            orderId,
            shipmentId: item.shipmentId,
            shipmentItemId,
            serials: changed,
          },
        },
        tx,
      );
      return this.ordersRepository.findForTransaction(tx, orderId);
    });
  }

  private async assertAssignable(tx: Prisma.TransactionClient, orderId: string, shipmentId: string): Promise<void> {
    const order = await this.ordersRepository.lockForFulfilment(tx, orderId);
    if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
    if (!FULFILLABLE_STATUSES.includes(order.status)) {
      throw new ConflictException(
        `Order "${orderId}" is ${order.status}; serials are assigned only to ${FULFILLABLE_STATUSES.join(' or ')} orders`,
      );
    }
    const shipment = await this.shipmentsRepository.findShipment(tx, shipmentId);
    if (!SERIAL_ASSIGNMENT_STATUSES.includes(shipment.status)) {
      throw new ConflictException(
        `Serials are assigned while the shipment is ${SERIAL_ASSIGNMENT_STATUSES.join(' or ')}; shipment ` +
          `"${shipmentId}" is ${shipment.status}`,
      );
    }
  }
}
