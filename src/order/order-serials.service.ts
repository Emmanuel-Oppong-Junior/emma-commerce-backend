import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Order, OrderItem, Prisma, ShipmentStatus } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { SerialLookup } from '../inventory/serials/serial-units.repository';
import { FULFILLABLE_STATUSES } from './order-status';
import { OrdersRepository } from './order.repository';

/** Serials are assigned while the goods are being picked or packed, before dispatch. */
export const SERIAL_ASSIGNMENT_STATUSES: ShipmentStatus[] = [ShipmentStatus.PICKING, ShipmentStatus.PACKED];

type Assignment = 'assign' | 'unassign';

/**
 * Serial units at pick (P4-D.1): staff (order.fulfil) assign the units they picked to each serial-tracked order line,
 * or take them off again, while the order's shipment is PICKING or PACKED. Runs with the order row locked, like every
 * fulfilment step, and is audited. Dispatch then requires every serialised line to be fully assigned.
 */
@Injectable()
export class OrderSerialsService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly serialUnits: SerialUnitsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * @throws NotFoundException for an unknown line or deleted order; ConflictException when the order is not being
   * fulfilled or its shipment is not PICKING or PACKED; and what SerialUnitsService.assign throws.
   */
  async assign(orderItemId: string, serials: string[], actorId: string): Promise<Order & { items: OrderItem[] }> {
    return this.change('assign', orderItemId, serials, actorId);
  }

  /** As assign; each serial must be assigned to this line. */
  async unassign(orderItemId: string, serials: string[], actorId: string): Promise<Order & { items: OrderItem[] }> {
    return this.change('unassign', orderItemId, serials, actorId);
  }

  async lookup(serial: string): Promise<SerialLookup[]> {
    return this.serialUnits.lookup(serial);
  }

  private async change(
    kind: Assignment,
    orderItemId: string,
    serials: string[],
    actorId: string,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const orderId = await this.ordersRepository.findItemOrderId(tx, orderItemId);
      if (!orderId) throw new NotFoundException(`Order line "${orderItemId}" not found`);
      await this.assertAssignable(tx, orderId);
      const source = { actorId, refType: 'Order', refId: orderId };
      const changed =
        kind === 'assign'
          ? await this.serialUnits.assign(tx, orderItemId, serials, source)
          : await this.serialUnits.unassign(tx, orderItemId, serials, source);
      await this.auditService.log(
        {
          entity: 'OrderItem',
          entityId: orderItemId,
          action: 'UPDATE',
          userId: actorId,
          details: { change: kind === 'assign' ? 'SERIALS_ASSIGNED' : 'SERIALS_UNASSIGNED', orderId, serials: changed },
        },
        tx,
      );
      return this.ordersRepository.findForTransaction(tx, orderId);
    });
  }

  private async assertAssignable(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const order = await this.ordersRepository.lockForFulfilment(tx, orderId);
    if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
    if (!FULFILLABLE_STATUSES.includes(order.status)) {
      throw new ConflictException(
        `Order "${orderId}" is ${order.status}; serials are assigned only to ${FULFILLABLE_STATUSES.join(' or ')} orders`,
      );
    }
    const shipment = await this.ordersRepository.findShipment(tx, orderId);
    if (!shipment || !SERIAL_ASSIGNMENT_STATUSES.includes(shipment.status)) {
      throw new ConflictException(
        `Serials are assigned while the shipment is ${SERIAL_ASSIGNMENT_STATUSES.join(' or ')}; the shipment of order ` +
          `"${orderId}" is ${shipment?.status ?? 'not started'}`,
      );
    }
  }
}
