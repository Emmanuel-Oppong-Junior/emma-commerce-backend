import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Order, OrderItem, OrderStatus, PaymentMethod, Prisma, ShipmentStatus } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { OutboxService } from '../outbox/outbox.service';
import { FULFILLABLE_STATUSES } from './order-status';
import { OrderForFulfilment, OrdersRepository, ShipmentWithItems } from './order.repository';
import { isOrderDelivered, planShipment, ShipmentLine } from './shipment-allocation';
import { isShipmentMilestone, shipmentStatusChanged } from './shipment-events';
import { canShipmentTransition, isDispatch, isShipmentOpen } from './shipment-status';
import { ShipmentsRepository } from './shipments.repository';
import { riderMayMove } from '../delivery/rider-assignment';

type Tx = Prisma.TransactionClient;
type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Shipments of an order (P5-B.1, staff with order.fulfil): created from the order's unshipped units, moved through the
 * shipment machine one at a time, cancelled before dispatch. Every change runs with the order row locked, so
 * allocations and order moves never race, and is audited. The order follows its shipments: the first step of any
 * shipment starts fulfilment; an online order completes when all its units are delivered (or refunded); a
 * cash-on-delivery order, never split, completes when its cash is recorded (recordCodPayment).
 */
@Injectable()
export class ShipmentsService {
  constructor(
    private readonly shipmentsRepository: ShipmentsRepository,
    private readonly ordersRepository: OrdersRepository,
    private readonly auditService: AuditService,
    private readonly stockLedger: StockLedgerService,
    private readonly serialUnits: SerialUnitsService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * A PENDING shipment of a confirmed or in-fulfilment order with the given lines, or every unshipped unit when none
   * are given. BAD_REQUEST for a line not on the order, named twice or with a quantity below 1, and for a
   * cash-on-delivery order not shipped whole (reason COD_ORDER_NOT_SPLIT); CONFLICT for more units than are unshipped
   * (SHIPMENT_QUANTITY_EXCEEDED) or nothing left to ship (NOTHING_TO_SHIP).
   */
  async createShipment(orderId: string, lines: ShipmentLine[] | undefined, actorId: string) {
    const shipmentId = await this.shipmentsRepository.runTransaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      const { lines: orderLines, shipments } = await this.shipmentsRepository.findAllocation(tx, orderId);
      const plan = planShipment(order.paymentMethod, orderLines, shipments, lines);
      if (!plan.ok) {
        const body = { message: plan.problem, ...(plan.reason && { extensions: { reason: plan.reason } }) };
        throw plan.conflict ? new ConflictException(body) : new BadRequestException(body);
      }
      const shipment = await this.shipmentsRepository.create(tx, orderId, plan.lines, actorId);
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipment.id,
          action: 'CREATE',
          userId: actorId,
          details: { orderId, items: plan.lines.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })) },
        },
        tx,
      );
      return shipment.id;
    });
    return this.shipmentsRepository.findWithHistory(shipmentId);
  }

  /**
   * Cancels a shipment that has not been dispatched: its units are unshipped again and the serials picked for it go
   * back on the shelf. An online order whose other shipments then hold every unit delivered (or refunded) completes.
   */
  async cancelShipment(shipmentId: string, actorId: string, reason?: string): Promise<OrderWithItems> {
    return this.shipmentsRepository.runTransaction(async (tx) => {
      const { order, shipment } = await this.lockShipment(tx, shipmentId);
      if (!canShipmentTransition(shipment.status, ShipmentStatus.CANCELLED, order.fulfillmentType)) {
        throw new ConflictException(
          `Shipment "${shipmentId}" is ${shipment.status}; only a shipment not yet dispatched can be cancelled`,
        );
      }
      const cancelled = await this.ordersRepository.transitionShipment(
        tx,
        shipmentId,
        shipment.status,
        ShipmentStatus.CANCELLED,
        { actorId, reason },
      );
      if (!cancelled) throw this.changedMeanwhile(order.id);
      await this.serialUnits.releaseShipment(tx, shipmentId, { actorId, refType: 'Shipment', refId: shipmentId });
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipmentId,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: {
            orderId: order.id,
            from: shipment.status,
            to: ShipmentStatus.CANCELLED,
            ...(reason && { reason }),
          },
        },
        tx,
      );
      await this.completeIfDelivered(tx, order, order.status, actorId, reason);
      return this.ordersRepository.findForTransaction(tx, order.id);
    });
  }

  /**
   * Moves a shipment one step through the fulfilment machine. In the same transaction: the first step of any shipment
   * moves a CONFIRMED order to IN_FULFILMENT; dispatch (READY_FOR_PICKUP / OUT_FOR_DELIVERY) requires a serial
   * assigned to every serialised unit of the shipment, marks them SOLD and consumes a cash-on-delivery order's
   * reserved stock (its one shipment carries everything; only ACTIVE reservations are consumed, so once); DELIVERED
   * starts the warranty of the shipment's units. Dispatch and delivery record `shipment.status_changed.v1`. An online
   * order completes (`order.status_changed.v2`) once its shipments hold every unit delivered or refunded. A
   * cash-on-delivery shipment is delivered by recording its cash (recordCodPayment); cancelling is cancelShipment.
   */
  async updateShipmentStatus(
    shipmentId: string,
    to: ShipmentStatus,
    actorId: string,
    reason?: string,
  ): Promise<OrderWithItems> {
    if (to === ShipmentStatus.CANCELLED) {
      throw new BadRequestException('Cancel a shipment with cancelShipment, which gives its units back to the order');
    }
    return this.shipmentsRepository.runTransaction(async (tx) => {
      const { order, shipment } = await this.lockShipment(tx, shipmentId);
      await this.moveLocked(tx, order, shipment, to, actorId, reason);
      return this.ordersRepository.findForTransaction(tx, order.id);
    });
  }

  /**
   * A rider's step on a shipment assigned to them (P5-C.1): out for delivery from packed or after a failed attempt, or
   * failed. NOT_FOUND for a shipment that is not theirs, whether or not it exists; CONFLICT for any other step.
   */
  async moveAsRider(shipmentId: string, to: ShipmentStatus, riderId: string, reason?: string): Promise<void> {
    const notYours = () => new NotFoundException(`Shipment "${shipmentId}" not found`);
    if ((await this.shipmentsRepository.findRiderId(shipmentId)) !== riderId) throw notYours();
    await this.shipmentsRepository.runTransaction(async (tx) => {
      const { order, shipment } = await this.lockShipment(tx, shipmentId);
      if (shipment.riderId !== riderId) throw notYours();
      if (!riderMayMove(shipment.status, to)) {
        throw new ConflictException(`Shipment "${shipmentId}" is ${shipment.status}; a rider cannot move it to ${to}`);
      }
      await this.moveLocked(tx, order, shipment, to, riderId, reason);
    });
  }

  /** One step of updateShipmentStatus on the caller's transaction, with the shipment's order locked (lockShipment). */
  private async moveLocked(
    tx: Tx,
    order: OrderForFulfilment,
    shipment: ShipmentWithItems,
    to: ShipmentStatus,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    const shipmentId = shipment.id;
    if (to === ShipmentStatus.DELIVERED && order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      throw new BadRequestException(
        `Order "${order.id}" is paid on delivery; record the cash collected (recordCodPayment) to deliver it`,
      );
    }
    if (!canShipmentTransition(shipment.status, to, order.fulfillmentType)) {
      throw new ConflictException(
        `Shipment "${shipmentId}" of order "${order.id}" cannot move from ${shipment.status} to ${to} ` +
          `(${order.fulfillmentType})`,
      );
    }
    const moved = await this.ordersRepository.transitionShipment(tx, shipmentId, shipment.status, to, {
      actorId,
      reason,
    });
    if (!moved) throw this.changedMeanwhile(order.id);
    await this.auditService.log(
      {
        entity: 'Shipment',
        entityId: shipmentId,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { orderId: order.id, from: shipment.status, to, ...(reason && { reason }) },
      },
      tx,
    );

    let orderStatus = order.status;
    if (orderStatus === OrderStatus.CONFIRMED) {
      await this.moveOrder(tx, order.id, OrderStatus.CONFIRMED, OrderStatus.IN_FULFILMENT, actorId, reason);
      orderStatus = OrderStatus.IN_FULFILMENT;
    }
    if (isDispatch(to)) {
      await this.serialUnits.dispatchShipment(tx, shipmentId, { actorId, refType: 'Shipment', refId: shipmentId });
      if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
        await this.stockLedger.consumeOrder(tx, order.id, actorId);
      }
    }
    if (to === ShipmentStatus.DELIVERED) {
      await this.serialUnits.startWarranty(tx, shipmentId, moved.deliveredAt!);
    }
    if (isShipmentMilestone(to)) await this.outbox.record(tx, shipmentStatusChanged(order.id, moved));
    if (!isShipmentOpen(to)) await this.completeIfDelivered(tx, order, orderStatus, actorId, reason);
  }

  /**
   * Sets the carrier and tracking number of a shipment of a confirmed or in-fulfilment order. A tracking number also
   * records `shipment.tracking_updated.v1` in the same transaction, which the worker turns into the customer email.
   */
  async updateShipping(
    shipmentId: string,
    trackingNumber: string | undefined,
    carrier: string | undefined,
    actorId: string,
  ): Promise<OrderWithItems> {
    return this.shipmentsRepository.runTransaction(async (tx) => {
      const { order, shipment } = await this.lockShipment(tx, shipmentId);
      if (shipment.status === ShipmentStatus.CANCELLED) {
        throw new ConflictException(`Shipment "${shipmentId}" is cancelled`);
      }
      await this.ordersRepository.updateShipmentTracking(tx, shipmentId, { trackingNumber, carrier });
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipmentId,
          action: 'UPDATE',
          userId: actorId,
          details: { orderId: order.id, trackingNumber, carrier },
        },
        tx,
      );
      if (trackingNumber) {
        await this.outbox.record(tx, {
          type: 'shipment.tracking_updated.v1',
          aggregateId: order.id,
          payload: { orderId: order.id, shipmentId, trackingNumber },
        });
      }
      return this.ordersRepository.findForTransaction(tx, order.id);
    });
  }

  async getShipments(orderId: string) {
    return this.ordersRepository.findShipments(orderId);
  }

  /** Locks the order of a confirmed or in-fulfilment order for a fulfilment change. */
  private async lockOrder(tx: Tx, orderId: string): Promise<OrderForFulfilment> {
    const order = await this.ordersRepository.lockForFulfilment(tx, orderId);
    if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
    if (!FULFILLABLE_STATUSES.includes(order.status)) {
      throw new ConflictException(
        `Order "${orderId}" is ${order.status}; only ${FULFILLABLE_STATUSES.join(' or ')} orders can be fulfilled`,
      );
    }
    return order;
  }

  /** Locks the shipment's order (see lockOrder), then reads the shipment as it is under that lock. */
  async lockShipment(tx: Tx, shipmentId: string): Promise<{ order: OrderForFulfilment; shipment: ShipmentWithItems }> {
    const orderId = await this.shipmentsRepository.findOrderId(tx, shipmentId);
    if (!orderId) throw new NotFoundException(`Shipment "${shipmentId}" not found`);
    const order = await this.lockOrder(tx, orderId);
    return { order, shipment: await this.shipmentsRepository.findShipment(tx, shipmentId) };
  }

  /** Completes an online order in fulfilment whose shipments now hold every unit delivered or refunded. */
  private async completeIfDelivered(
    tx: Tx,
    order: OrderForFulfilment,
    orderStatus: OrderStatus,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    if (order.paymentMethod !== PaymentMethod.ONLINE || orderStatus !== OrderStatus.IN_FULFILMENT) return;
    const { lines, shipments } = await this.shipmentsRepository.findAllocation(tx, order.id);
    const refunded = await this.shipmentsRepository.refundedUnits(tx, order.id);
    if (!isOrderDelivered(lines, shipments, refunded)) return;
    await this.moveOrder(tx, order.id, OrderStatus.IN_FULFILMENT, OrderStatus.COMPLETED, actorId, reason);
    await this.outbox.record(tx, {
      type: 'order.status_changed.v2',
      aggregateId: order.id,
      payload: { orderId: order.id, from: OrderStatus.IN_FULFILMENT, to: OrderStatus.COMPLETED },
    });
  }

  private async moveOrder(
    tx: Tx,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    const moved = await this.ordersRepository.transitionStatus(tx, orderId, to, [from], { actorId, reason });
    if (!moved) throw this.changedMeanwhile(orderId);
    await this.auditService.log(
      {
        entity: 'Order',
        entityId: orderId,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from, to, ...(reason && { reason }) },
      },
      tx,
    );
  }

  private changedMeanwhile(orderId: string): ConflictException {
    return new ConflictException(`Order "${orderId}" was changed by another request; reload it and try again`);
  }
}
