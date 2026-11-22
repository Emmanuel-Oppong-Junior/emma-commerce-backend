import { OrdersService } from '../../src/order/order.service';
import { codRiskStub, velocityStub } from '../helpers/velocity.helper';

function buildOrdersService(order: Record<string, unknown>) {
  const repository = {
    findById: jest.fn().mockResolvedValue(order),
    runTransaction: jest.fn((work: (tx: unknown) => unknown) => work({})),
    restoreVariantStock: jest.fn().mockResolvedValue({ quantity: 10 }),
    updateStatus: jest.fn().mockResolvedValue({ ...order, status: 'CANCELLED' }),
    softDelete: jest.fn().mockResolvedValue({ ...order, deleted: true }),
    hasCompletedPayment: jest.fn().mockResolvedValue(false),
    findUserById: jest.fn().mockResolvedValue({ email: 'customer@test.local' }),
    lockForFulfilment: jest.fn().mockResolvedValue({ ...order, deleted: false }),
    transitionShipment: jest.fn(),
  };
  const inventory = { logInventoryChange: jest.fn() };
  const service = new OrdersService(
    repository as never,
    {} as never,
    { log: jest.fn() } as never,
    inventory as never,
    { sendOrderStatusUpdate: jest.fn() } as never,
    {} as never,
    {} as never,
    { createSystemReturnRequest: jest.fn() } as never,
    {} as never,
    {} as never,
    { getCurrency: jest.fn().mockResolvedValue('GHS') } as never,
    { findActive: jest.fn().mockResolvedValue([]) } as never,
    { assertOrderPaymentMethod: jest.fn() } as never,
    velocityStub() as never,
    codRiskStub() as never,
    {} as never,
  );
  return { service, repository };
}

describe('Order lifecycle (audit repro: ORD-01, ORD-03, ORD-04)', () => {
  it('ORD-01: cancelling an already CANCELLED order is rejected and restores no stock', async () => {
    const order = {
      id: 'order-1',
      userId: 'user-1',
      status: 'CANCELLED',
      paymentMethod: 'ONLINE',
      items: [{ productId: 'product-1', quantity: 3 }],
    };
    const { service, repository } = buildOrdersService(order);

    await expect(service.cancelOrder('user-1', 'order-1')).rejects.toThrow();
    expect(repository.restoreVariantStock).not.toHaveBeenCalled();
  });

  it('ORD-03: soft-deleting a DELIVERED order does not put its items back into stock', async () => {
    const order = {
      id: 'order-1',
      userId: 'user-1',
      status: 'COMPLETED',
      paymentMethod: 'ONLINE',
      items: [{ productId: 'product-1', quantity: 2 }],
    };
    const { service, repository } = buildOrdersService(order);

    await service.deleteOrder('order-1', 'admin-1').catch(() => undefined);

    expect(repository.restoreVariantStock).not.toHaveBeenCalled();
  });

  it('ORD-04: an admin cannot move a CANCELLED order to SHIPPED', async () => {
    const order = { id: 'order-1', userId: 'user-1', status: 'CANCELLED', paymentMethod: 'ONLINE', items: [] };
    const { service, repository } = buildOrdersService(order);

    await expect(service.updateShipmentStatus('order-1', 'OUT_FOR_DELIVERY' as never, 'admin-1')).rejects.toThrow();
    expect(repository.updateStatus).not.toHaveBeenCalled();
    expect(repository.transitionShipment).not.toHaveBeenCalled();
  });
});
