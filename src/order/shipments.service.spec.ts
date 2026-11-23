import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';
import { ShipmentsService } from './shipments.service';

const stubTx = { id: 'tx' };

const ordersRepository = {
  lockForFulfilment: jest.fn(),
  transitionShipment: jest.fn(),
  transitionStatus: jest.fn(),
  updateShipmentTracking: jest.fn(),
  findForTransaction: jest.fn(),
  findShipments: jest.fn(),
};
const shipmentsRepository = {
  runTransaction: jest.fn(),
  findOrderId: jest.fn(),
  findShipment: jest.fn(),
  findAllocation: jest.fn(),
  create: jest.fn(),
  findWithHistory: jest.fn(),
  refundedUnits: jest.fn(),
};
const auditService = { log: jest.fn() };
const stockLedger = { consumeOrder: jest.fn() };
const serialUnits = { dispatchShipment: jest.fn(), releaseShipment: jest.fn(), startWarranty: jest.fn() };
const outbox = { record: jest.fn() };

const service = new ShipmentsService(
  shipmentsRepository as never,
  ordersRepository as never,
  auditService as never,
  stockLedger as never,
  serialUnits as never,
  outbox as never,
);

const confirmed = {
  id: 'order1',
  userId: 'user1',
  status: OrderStatus.CONFIRMED,
  deleted: false,
  fulfillmentType: 'DELIVERY',
  paymentMethod: 'ONLINE',
};
const items = [{ orderItemId: 'item1', quantity: 2 }];
const shipment = (status: string) => ({
  id: 'ship1',
  orderId: 'order1',
  status,
  carrier: 'DHL',
  trackingNumber: 'TRK1',
  deliveredAt: status === 'DELIVERED' ? new Date('2026-11-23T10:00:00Z') : null,
  items,
});

describe('ShipmentsService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    shipmentsRepository.runTransaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(stubTx));
    shipmentsRepository.findOrderId.mockResolvedValue('order1');
    shipmentsRepository.findShipment.mockResolvedValue(shipment('PENDING'));
    shipmentsRepository.refundedUnits.mockResolvedValue(new Map());
    ordersRepository.lockForFulfilment.mockResolvedValue(confirmed);
    ordersRepository.transitionShipment.mockImplementation(async (_tx, _id, _from, to) => shipment(to));
    ordersRepository.transitionStatus.mockResolvedValue({ id: 'order1', status: OrderStatus.IN_FULFILMENT });
    ordersRepository.findForTransaction.mockResolvedValue({ id: 'order1', status: OrderStatus.IN_FULFILMENT });
  });

  describe('updateShipmentStatus', () => {
    it('moves the shipment, puts the confirmed order in fulfilment and audits both on the same transaction', async () => {
      const result = await service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1', 'Started');

      expect(ordersRepository.lockForFulfilment).toHaveBeenCalledWith(stubTx, 'order1');
      expect(ordersRepository.transitionShipment).toHaveBeenCalledWith(stubTx, 'ship1', 'PENDING', 'PICKING', {
        actorId: 'admin1',
        reason: 'Started',
      });
      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(
        stubTx,
        'order1',
        OrderStatus.IN_FULFILMENT,
        [OrderStatus.CONFIRMED],
        { actorId: 'admin1', reason: 'Started' },
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Shipment', entityId: 'ship1', action: 'STATUS_CHANGE', userId: 'admin1' }),
        stubTx,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', entityId: 'order1', action: 'STATUS_CHANGE', userId: 'admin1' }),
        stubTx,
      );
      expect(result.status).toBe('IN_FULFILMENT');
    });

    it('locks the order before reading the shipment it moves', async () => {
      await service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1');

      expect(ordersRepository.lockForFulfilment.mock.invocationCallOrder[0]).toBeLessThan(
        shipmentsRepository.findShipment.mock.invocationCallOrder[0],
      );
    });

    it('records shipment.status_changed.v1 with carrier and items on dispatch and on delivery, in the transaction', async () => {
      shipmentsRepository.findShipment.mockResolvedValue(shipment('PACKED'));

      await service.updateShipmentStatus('ship1', 'OUT_FOR_DELIVERY' as never, 'admin1');

      expect(outbox.record).toHaveBeenCalledWith(stubTx, {
        type: 'shipment.status_changed.v1',
        aggregateId: 'order1',
        payload: {
          orderId: 'order1',
          shipmentId: 'ship1',
          status: 'OUT_FOR_DELIVERY',
          trackingNumber: 'TRK1',
          carrier: 'DHL',
          items,
        },
      });

      outbox.record.mockClear();
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status: OrderStatus.IN_FULFILMENT });
      shipmentsRepository.findShipment.mockResolvedValue(shipment('OUT_FOR_DELIVERY'));
      shipmentsRepository.findAllocation.mockResolvedValue({
        lines: [{ id: 'item1', quantity: 2 }],
        shipments: [{ id: 'ship1', status: 'DELIVERED', items }],
      });

      await service.updateShipmentStatus('ship1', 'DELIVERED' as never, 'admin1');

      expect(serialUnits.startWarranty).toHaveBeenCalledWith(stubTx, 'ship1', new Date('2026-11-23T10:00:00Z'));
      expect(ordersRepository.transitionStatus).toHaveBeenLastCalledWith(
        stubTx,
        'order1',
        OrderStatus.COMPLETED,
        [OrderStatus.IN_FULFILMENT],
        { actorId: 'admin1', reason: undefined },
      );
      expect(outbox.record).toHaveBeenCalledTimes(2);
      expect(outbox.record).toHaveBeenCalledWith(
        stubTx,
        expect.objectContaining({
          type: 'shipment.status_changed.v1',
          payload: expect.objectContaining({ status: 'DELIVERED' }),
        }),
      );
      expect(outbox.record).toHaveBeenCalledWith(stubTx, {
        type: 'order.status_changed.v2',
        aggregateId: 'order1',
        payload: { orderId: 'order1', from: OrderStatus.IN_FULFILMENT, to: OrderStatus.COMPLETED },
      });
    });

    it('keeps the order in fulfilment when a delivered shipment leaves units in another shipment or unshipped', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status: OrderStatus.IN_FULFILMENT });
      shipmentsRepository.findShipment.mockResolvedValue(shipment('OUT_FOR_DELIVERY'));
      shipmentsRepository.findAllocation.mockResolvedValue({
        lines: [{ id: 'item1', quantity: 3 }],
        shipments: [{ id: 'ship1', status: 'DELIVERED', items }],
      });

      await service.updateShipmentStatus('ship1', 'DELIVERED' as never, 'admin1');

      expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
      expect(outbox.record).toHaveBeenCalledTimes(1);
    });

    it('records no event for a step that is not a milestone', async () => {
      await service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1');

      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown shipment or a missing order', async () => {
      shipmentsRepository.findOrderId.mockResolvedValueOnce(null);
      await expect(service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1')).rejects.toThrow(
        NotFoundException,
      );

      ordersRepository.lockForFulfilment.mockResolvedValue(null);
      await expect(service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a step the shipment table does not allow, without writing', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status: OrderStatus.IN_FULFILMENT });
      shipmentsRepository.findShipment.mockResolvedValue(shipment('DELIVERED'));

      await expect(service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1')).rejects.toThrow(
        new ConflictException('Shipment "ship1" of order "order1" cannot move from DELIVERED to PICKING (DELIVERY)'),
      );
      expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
    });

    it('refuses the pickup counter for a delivery order', async () => {
      await expect(service.updateShipmentStatus('ship1', 'READY_FOR_PICKUP' as never, 'admin1')).rejects.toThrow(
        ConflictException,
      );
      expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
    });

    it('sends cancelling to cancelShipment', async () => {
      await expect(service.updateShipmentStatus('ship1', 'CANCELLED' as never, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
      expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.PLACED, OrderStatus.CANCELLED, OrderStatus.COMPLETED])(
      'does not let staff fulfil a %s order (an unpaid online order cannot skip payment)',
      async (status) => {
        ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status });

        await expect(service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1')).rejects.toThrow(
          ConflictException,
        );
        expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
        expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
      },
    );

    it('makes a cash-on-delivery order record its cash to be delivered', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({
        ...confirmed,
        status: OrderStatus.IN_FULFILMENT,
        paymentMethod: 'CASH_ON_DELIVERY',
      });

      await expect(service.updateShipmentStatus('ship1', 'DELIVERED' as never, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
      expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
    });

    it('checks the serials of this shipment and consumes a cash-on-delivery order on dispatch, after the claim', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, paymentMethod: 'CASH_ON_DELIVERY' });

      await service.updateShipmentStatus('ship1', 'OUT_FOR_DELIVERY' as never, 'admin1');

      expect(serialUnits.dispatchShipment).toHaveBeenCalledWith(stubTx, 'ship1', {
        actorId: 'admin1',
        refType: 'Shipment',
        refId: 'ship1',
      });
      expect(stockLedger.consumeOrder).toHaveBeenCalledWith(stubTx, 'order1', 'admin1');
      expect(ordersRepository.transitionShipment.mock.invocationCallOrder[0]).toBeLessThan(
        stockLedger.consumeOrder.mock.invocationCallOrder[0],
      );
    });

    it('consumes nothing for an online order (consumed at payment) or a step before dispatch', async () => {
      await service.updateShipmentStatus('ship1', 'OUT_FOR_DELIVERY' as never, 'admin1');
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, paymentMethod: 'CASH_ON_DELIVERY' });
      await service.updateShipmentStatus('ship1', 'PACKED' as never, 'admin1');

      expect(stockLedger.consumeOrder).not.toHaveBeenCalled();
    });

    it('consumes nothing when the shipment claim is lost to another request', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, paymentMethod: 'CASH_ON_DELIVERY' });
      ordersRepository.transitionShipment.mockResolvedValue(null);

      await expect(service.updateShipmentStatus('ship1', 'OUT_FOR_DELIVERY' as never, 'admin1')).rejects.toThrow(
        /changed by another request/,
      );
      expect(stockLedger.consumeOrder).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('reports a conflict when another request moved the order first', async () => {
      ordersRepository.transitionStatus.mockResolvedValue(null);

      await expect(service.updateShipmentStatus('ship1', 'PICKING' as never, 'admin1')).rejects.toThrow(
        /changed by another request/,
      );
    });

    it('fails the status change from inside the transaction when the audit write fails, so it rolls back', async () => {
      shipmentsRepository.findShipment.mockResolvedValue(shipment('PACKED'));
      auditService.log.mockRejectedValue(new Error('audit insert failed'));

      await expect(service.updateShipmentStatus('ship1', 'OUT_FOR_DELIVERY' as never, 'admin1')).rejects.toThrow(
        'audit insert failed',
      );
      await expect(shipmentsRepository.runTransaction.mock.results[0].value).rejects.toThrow('audit insert failed');
      expect(outbox.record).not.toHaveBeenCalled();
    });
  });

  describe('createShipment', () => {
    beforeEach(() => {
      shipmentsRepository.findAllocation.mockResolvedValue({
        lines: [
          { id: 'item1', quantity: 2 },
          { id: 'item2', quantity: 1 },
        ],
        shipments: [],
      });
      shipmentsRepository.create.mockResolvedValue({ id: 'ship9' });
      shipmentsRepository.findWithHistory.mockResolvedValue({ id: 'ship9' });
    });

    it('ships every unshipped unit by default, under the order lock, and audits it in the same transaction', async () => {
      const created = await service.createShipment('order1', undefined, 'admin1');

      expect(ordersRepository.lockForFulfilment).toHaveBeenCalledWith(stubTx, 'order1');
      expect(shipmentsRepository.create).toHaveBeenCalledWith(
        stubTx,
        'order1',
        [
          { orderItemId: 'item1', quantity: 2 },
          { orderItemId: 'item2', quantity: 1 },
        ],
        'admin1',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        {
          entity: 'Shipment',
          entityId: 'ship9',
          action: 'CREATE',
          userId: 'admin1',
          details: {
            orderId: 'order1',
            items: [
              { orderItemId: 'item1', quantity: 2 },
              { orderItemId: 'item2', quantity: 1 },
            ],
          },
        },
        stubTx,
      );
      expect(created).toEqual({ id: 'ship9' });
    });

    it('refuses more units than are unshipped with CONFLICT and reason SHIPMENT_QUANTITY_EXCEEDED, writing nothing', async () => {
      shipmentsRepository.findAllocation.mockResolvedValue({
        lines: [{ id: 'item1', quantity: 2 }],
        shipments: [{ id: 'ship1', status: 'PENDING', items: [{ orderItemId: 'item1', quantity: 1 }] }],
      });

      const error = await service
        .createShipment('order1', [{ orderItemId: 'item1', quantity: 2 }], 'admin1')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        extensions: { reason: 'SHIPMENT_QUANTITY_EXCEEDED' },
      });
      expect(shipmentsRepository.create).not.toHaveBeenCalled();
    });

    it('refuses to split a cash-on-delivery order with BAD_REQUEST and reason COD_ORDER_NOT_SPLIT', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, paymentMethod: 'CASH_ON_DELIVERY' });

      const error = await service
        .createShipment('order1', [{ orderItemId: 'item1', quantity: 2 }], 'admin1')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'COD_ORDER_NOT_SPLIT' },
      });
      expect(shipmentsRepository.create).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.PLACED, OrderStatus.CANCELLED])('refuses a shipment for a %s order', async (status) => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status });

      await expect(service.createShipment('order1', undefined, 'admin1')).rejects.toThrow(ConflictException);
      expect(shipmentsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('cancelShipment', () => {
    it('cancels a shipment not yet dispatched, puts its picked serials back and audits it', async () => {
      shipmentsRepository.findShipment.mockResolvedValue(shipment('PACKED'));

      await service.cancelShipment('ship1', 'admin1', 'Repacking');

      expect(ordersRepository.transitionShipment).toHaveBeenCalledWith(stubTx, 'ship1', 'PACKED', 'CANCELLED', {
        actorId: 'admin1',
        reason: 'Repacking',
      });
      expect(serialUnits.releaseShipment).toHaveBeenCalledWith(stubTx, 'ship1', {
        actorId: 'admin1',
        refType: 'Shipment',
        refId: 'ship1',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        {
          entity: 'Shipment',
          entityId: 'ship1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: { orderId: 'order1', from: 'PACKED', to: 'CANCELLED', reason: 'Repacking' },
        },
        stubTx,
      );
      expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('refuses once the shipment has been dispatched', async () => {
      shipmentsRepository.findShipment.mockResolvedValue(shipment('OUT_FOR_DELIVERY'));

      await expect(service.cancelShipment('ship1', 'admin1')).rejects.toThrow(ConflictException);
      expect(ordersRepository.transitionShipment).not.toHaveBeenCalled();
    });

    it('completes an online order whose remaining units were delivered or refunded', async () => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status: OrderStatus.IN_FULFILMENT });
      shipmentsRepository.findAllocation.mockResolvedValue({
        lines: [{ id: 'item1', quantity: 3 }],
        shipments: [
          { id: 'ship0', status: 'DELIVERED', items },
          { id: 'ship1', status: 'CANCELLED', items: [{ orderItemId: 'item1', quantity: 1 }] },
        ],
      });
      shipmentsRepository.refundedUnits.mockResolvedValue(new Map([['item1', 1]]));

      await service.cancelShipment('ship1', 'admin1');

      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(
        stubTx,
        'order1',
        OrderStatus.COMPLETED,
        [OrderStatus.IN_FULFILMENT],
        { actorId: 'admin1', reason: undefined },
      );
    });
  });

  describe('updateShipping', () => {
    it('writes the shipping update and its audit entry on the same transaction', async () => {
      await service.updateShipping('ship1', undefined, 'DHL', 'admin1');

      expect(ordersRepository.updateShipmentTracking).toHaveBeenCalledWith(stubTx, 'ship1', {
        trackingNumber: undefined,
        carrier: 'DHL',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        {
          entity: 'Shipment',
          entityId: 'ship1',
          action: 'UPDATE',
          userId: 'admin1',
          details: { orderId: 'order1', trackingNumber: undefined, carrier: 'DHL' },
        },
        stubTx,
      );
    });

    it.each([OrderStatus.PLACED, OrderStatus.CANCELLED])('refuses shipping details on a %s order', async (status) => {
      ordersRepository.lockForFulfilment.mockResolvedValue({ ...confirmed, status });

      await expect(service.updateShipping('ship1', 'TRK1', 'DHL', 'admin1')).rejects.toThrow(ConflictException);
      expect(ordersRepository.updateShipmentTracking).not.toHaveBeenCalled();
    });

    it('refuses shipping details on a cancelled shipment', async () => {
      shipmentsRepository.findShipment.mockResolvedValue(shipment('CANCELLED'));

      await expect(service.updateShipping('ship1', 'TRK1', 'DHL', 'admin1')).rejects.toThrow(ConflictException);
      expect(ordersRepository.updateShipmentTracking).not.toHaveBeenCalled();
    });

    it('records shipment.tracking_updated.v1 with the tracking number in the shipping transaction', async () => {
      await service.updateShipping('ship1', 'TRK1', 'DHL', 'admin1');

      expect(outbox.record).toHaveBeenCalledWith(stubTx, {
        type: 'shipment.tracking_updated.v1',
        aggregateId: 'order1',
        payload: { orderId: 'order1', shipmentId: 'ship1', trackingNumber: 'TRK1' },
      });
    });

    it('records no shipment event when only the carrier changes', async () => {
      await service.updateShipping('ship1', undefined, 'DHL', 'admin1');

      expect(outbox.record).not.toHaveBeenCalled();
    });
  });
});
