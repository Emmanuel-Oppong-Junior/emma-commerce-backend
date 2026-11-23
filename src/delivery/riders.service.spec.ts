import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RidersService } from './riders.service';

const tx = { tx: true };
const repository = {
  runTransaction: jest.fn(),
  findRiderFacts: jest.fn(),
  setRider: jest.fn(),
  findDeliveries: jest.fn(),
  findDelivery: jest.fn(),
  findRiders: jest.fn(),
};
const shipments = { lockShipment: jest.fn(), moveAsRider: jest.fn() };
const shipmentsRepository = { findWithHistory: jest.fn() };
const auditService = { log: jest.fn() };

const service = new RidersService(
  repository as never,
  shipments as never,
  shipmentsRepository as never,
  auditService as never,
);

const order = { id: 'order1', fulfillmentType: 'DELIVERY' };
const locked = (status: string, riderId: string | null) => ({ order, shipment: { id: 'ship1', status, riderId } });
const rider = { isActive: true, role: { key: 'RIDER', permissions: ['delivery.ride'] } };

describe('RidersService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    repository.runTransaction.mockImplementation(async (work: (t: unknown) => unknown) => work(tx));
    repository.findRiderFacts.mockResolvedValue(rider);
    shipmentsRepository.findWithHistory.mockResolvedValue({ id: 'ship1' });
  });

  describe('assign', () => {
    it('sets the rider under the order lock and audits who, from whom and why', async () => {
      shipments.lockShipment.mockResolvedValue(locked('OUT_FOR_DELIVERY', 'rider1'));

      await service.assign('ship1', 'rider2', 'admin1', 'Bike broke down');

      expect(shipments.lockShipment).toHaveBeenCalledWith(tx, 'ship1');
      expect(repository.setRider).toHaveBeenCalledWith(tx, 'ship1', 'rider2');
      expect(auditService.log).toHaveBeenCalledWith(
        {
          entity: 'Shipment',
          entityId: 'ship1',
          action: 'RIDER_ASSIGN',
          userId: 'admin1',
          details: {
            orderId: 'order1',
            status: 'OUT_FOR_DELIVERY',
            from: 'rider1',
            to: 'rider2',
            reason: 'Bike broke down',
          },
        },
        tx,
      );
      expect(shipmentsRepository.findWithHistory).toHaveBeenCalledWith('ship1');
    });

    it('refuses someone who is not a rider and writes nothing', async () => {
      shipments.lockShipment.mockResolvedValue(locked('PACKED', null));
      repository.findRiderFacts.mockResolvedValue({
        isActive: true,
        role: { key: 'CASHIER', permissions: ['order.view'] },
      });

      await expect(service.assign('ship1', 'clerk1', 'admin1')).rejects.toThrow(BadRequestException);
      expect(repository.setRider).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('writes nothing when the rider already has the shipment', async () => {
      shipments.lockShipment.mockResolvedValue(locked('PACKED', 'rider1'));

      await service.assign('ship1', 'rider1', 'admin1');

      expect(repository.setRider).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('unassign', () => {
    it('clears the rider and audits it', async () => {
      shipments.lockShipment.mockResolvedValue(locked('PACKED', 'rider1'));

      await service.unassign('ship1', 'admin1');

      expect(repository.setRider).toHaveBeenCalledWith(tx, 'ship1', null);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RIDER_UNASSIGN',
          details: { orderId: 'order1', status: 'PACKED', from: 'rider1' },
        }),
        tx,
      );
    });
  });

  describe('rider views', () => {
    it('lists the open statuses by default, and a given day', async () => {
      repository.findDeliveries.mockResolvedValue([]);

      await service.myDeliveries('rider1', { first: 20 });
      await service.myDeliveries('rider1', { status: ['DELIVERED'] as never, date: '2026-11-23', first: 5 });

      expect(repository.findDeliveries).toHaveBeenNthCalledWith(
        1,
        'rider1',
        ['PENDING', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'],
        null,
        20,
      );
      expect(repository.findDeliveries).toHaveBeenNthCalledWith(
        2,
        'rider1',
        ['DELIVERED'],
        { from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-24T00:00:00Z') },
        5,
      );
    });

    it('says NOT_FOUND for a shipment that is not the rider’s', async () => {
      repository.findDelivery.mockResolvedValue(null);

      await expect(service.myDelivery('rider1', 'ship9')).rejects.toThrow(NotFoundException);
      expect(repository.findDelivery).toHaveBeenCalledWith('rider1', 'ship9');
    });
  });
});
