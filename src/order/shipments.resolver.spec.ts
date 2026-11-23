import { ShipmentStatusEnum } from './enums/order.enum';
import { ShipmentsResolver } from './shipments.resolver';
import { ShipmentsService } from './shipments.service';

describe('ShipmentsResolver', () => {
  const service = {
    getShipments: jest.fn(),
    createShipment: jest.fn(),
    cancelShipment: jest.fn(),
    updateShipmentStatus: jest.fn(),
    updateShipping: jest.fn(),
  };
  const resolver = new ShipmentsResolver(service as unknown as ShipmentsService);

  beforeEach(() => jest.resetAllMocks());

  it('moves the shipment and returns the order', async () => {
    const order = { id: 'order1', status: 'IN_FULFILMENT' };
    service.updateShipmentStatus.mockResolvedValue(order);

    const result = await resolver.updateShipmentStatus('admin1', {
      shipmentId: 'ship1',
      status: ShipmentStatusEnum.OUT_FOR_DELIVERY,
      reason: 'Rider Kofi',
    });

    expect(service.updateShipmentStatus).toHaveBeenCalledWith('ship1', 'OUT_FOR_DELIVERY', 'admin1', 'Rider Kofi');
    expect(result).toBe(order);
  });

  it('creates a shipment with the requested lines, or everything unshipped when none are given', async () => {
    await resolver.createShipment('admin1', { orderId: 'order1', items: [{ orderItemId: 'item1', quantity: 2 }] });
    await resolver.createShipment('admin1', { orderId: 'order1' });

    expect(service.createShipment).toHaveBeenNthCalledWith(
      1,
      'order1',
      [{ orderItemId: 'item1', quantity: 2 }],
      'admin1',
    );
    expect(service.createShipment).toHaveBeenNthCalledWith(2, 'order1', undefined, 'admin1');
  });

  it('cancels a shipment, sets its tracking and lists an order’s shipments', async () => {
    await resolver.cancelShipment('admin1', { shipmentId: 'ship1', reason: 'Split differently' });
    await resolver.updateShipping('admin1', { shipmentId: 'ship1', trackingNumber: 'TRK1', carrier: 'DHL' });
    await resolver.orderShipments('order1');

    expect(service.cancelShipment).toHaveBeenCalledWith('ship1', 'admin1', 'Split differently');
    expect(service.updateShipping).toHaveBeenCalledWith('ship1', 'TRK1', 'DHL', 'admin1');
    expect(service.getShipments).toHaveBeenCalledWith('order1');
  });
});
