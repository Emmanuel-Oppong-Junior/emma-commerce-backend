import { Test, TestingModule } from '@nestjs/testing';
import { ORDER_INCLUDE, OrderSnapshot, OrdersRepository } from './order.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Address, FulfillmentType, Order, OrderItem, Prisma, User } from '../generated/prisma/client';
import { SERVING_LOCATION } from '../inventory/locations/serving-locations';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'PENDING',
  totalAmount: new Prisma.Decimal(100),
  shippingAddressId: 'addr1',
  trackingNumber: null,
  carrier: null,
  deleted: false,
  deletedAt: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  items: [],
} as unknown as Order & { items: OrderItem[] };

const mockPrismaOrder = {
  findUnique: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const mockPrismaAddress = { findUnique: jest.fn(), findFirst: jest.fn() };
const mockPrismaUser = { findUnique: jest.fn() };
const mockPrismaVariant = { findUnique: jest.fn() };

const mockPrisma = {
  order: mockPrismaOrder,
  address: mockPrismaAddress,
  user: mockPrismaUser,
  variant: mockPrismaVariant,
  $transaction: jest.fn(),
};

const snapshotOf = (totals: { subtotal: number; shippingTotal: number; grandTotal: number }): OrderSnapshot => ({
  currency: 'GHS',
  pricingVersion: 1,
  lines: [],
  adjustments: [],
  shippingAdjustments: [],
  shippingZoneId: null,
  shippingFee: new Prisma.Decimal(0),
  delivery: null,
  subtotal: new Prisma.Decimal(totals.subtotal),
  discountTotal: new Prisma.Decimal(0),
  taxTotal: new Prisma.Decimal(0),
  shippingTotal: new Prisma.Decimal(totals.shippingTotal),
  grandTotal: new Prisma.Decimal(totals.grandTotal),
  quoteHash: 'hash',
});

describe('OrdersRepository', () => {
  let repository: OrdersRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrdersRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<OrdersRepository>(OrdersRepository);
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('should find an order by ID with the default order include', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      const result = await repository.findById('order1');

      expect(result).toEqual(mockOrder);
      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'order1' }, include: ORDER_INCLUDE }),
      );
    });

    it('should use custom include when provided', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      await repository.findById('order1', { items: { include: { product: true } } });

      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: { items: { include: { product: true } } } }),
      );
    });

    it('should return null if not found', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByUser', () => {
    it('should return all orders for a user', async () => {
      mockPrismaOrder.findMany.mockResolvedValue([mockOrder]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockOrder]);
      expect(mockPrismaOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user1', deleted: false } }),
      );
    });
  });

  describe('findAll', () => {
    it('should return all non-deleted orders', async () => {
      mockPrismaOrder.findMany.mockResolvedValue([mockOrder]);

      const result = await repository.findAll();

      expect(result).toEqual([mockOrder]);
      expect(mockPrismaOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deleted: false } }));
    });
  });

  describe('create', () => {
    it('should create an order via transaction', async () => {
      const mockTx = {
        order: {
          create: jest.fn().mockResolvedValue(mockOrder),
          findUniqueOrThrow: jest.fn().mockResolvedValue(mockOrder),
        },
        orderItem: { create: jest.fn() },
        orderAdjustment: { createMany: jest.fn() },
        $queryRaw: jest.fn().mockResolvedValue([{ orderNumber: 10042 }]),
      };

      const result = await repository.create(mockTx as any, 'user1', {
        snapshot: snapshotOf({ subtotal: 90, shippingTotal: 10, grandTotal: 100 }),
        fulfillmentType: FulfillmentType.DELIVERY,
        shippingAddressId: 'addr1',
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
      });

      expect(result).toEqual(mockOrder);
      expect(mockTx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderNumber: 10042,
            userId: 'user1',
            shippingAddressId: 'addr1',
            subtotal: new Prisma.Decimal(90),
            discountTotal: new Prisma.Decimal(0),
            shippingTotal: new Prisma.Decimal(10),
            grandTotal: new Prisma.Decimal(100),
          }),
        }),
      );
    });
  });

  it('refuses to create an order when there is no Store row to number it', async () => {
    const mockTx = { order: { create: jest.fn() }, $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(
      repository.create(mockTx as any, 'user1', {
        snapshot: snapshotOf({ subtotal: 90, shippingTotal: 10, grandTotal: 100 }),
        fulfillmentType: FulfillmentType.PICKUP,
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
      }),
    ).rejects.toThrow('No Store row exists to number the order');
    expect(mockTx.order.create).not.toHaveBeenCalled();
  });

  describe('findAddressById', () => {
    it('should find an address by ID', async () => {
      const mockAddress = { id: 'addr1', city: 'Accra' } as unknown as Address;
      mockPrismaAddress.findUnique.mockResolvedValue(mockAddress);

      const result = await repository.findAddressById('addr1');

      expect(result).toEqual(mockAddress);
    });

    it('should return null if not found', async () => {
      mockPrismaAddress.findUnique.mockResolvedValue(null);

      const result = await repository.findAddressById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('shipments', () => {
    const tx = {
      shipment: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      shipmentStatusEvent: { create: jest.fn() },
    };

    beforeEach(() => jest.resetAllMocks());

    it('updates the carrier and tracking number on the shipment', async () => {
      const updated = { id: 'ship1', trackingNumber: 'TRK123', carrier: 'DHL' };
      tx.shipment.update.mockResolvedValue(updated);

      const result = await repository.updateShipmentTracking(tx as any, 'ship1', {
        trackingNumber: 'TRK123',
        carrier: 'DHL',
      });

      expect(result).toEqual(updated);
      expect(tx.shipment.update).toHaveBeenCalledWith({
        where: { id: 'ship1' },
        data: { trackingNumber: 'TRK123', carrier: 'DHL' },
      });
    });

    it('returns the existing shipment or creates a PENDING one with its first history event', async () => {
      tx.shipment.findFirst.mockResolvedValueOnce({ id: 'ship1' }).mockResolvedValueOnce(null);
      tx.shipment.create.mockResolvedValue({ id: 'ship2' });

      expect(await repository.findOrCreateShipment(tx as any, 'order1')).toEqual({ id: 'ship1' });
      expect(await repository.findOrCreateShipment(tx as any, 'order1', 'admin1')).toEqual({ id: 'ship2' });
      expect(tx.shipment.create).toHaveBeenCalledWith({
        data: { orderId: 'order1', events: { create: { from: null, to: 'PENDING', actorId: 'admin1' } } },
      });
    });

    it('moves a shipment with a conditional write, stamps dispatch and records the event', async () => {
      tx.shipment.updateMany.mockResolvedValue({ count: 1 });
      tx.shipment.findUniqueOrThrow.mockResolvedValue({ id: 'ship1', status: 'OUT_FOR_DELIVERY' });

      await repository.transitionShipment(tx as any, 'ship1', 'PACKED' as any, 'OUT_FOR_DELIVERY' as any, {
        actorId: 'admin1',
        reason: 'Rider Kofi',
      });

      expect(tx.shipment.updateMany).toHaveBeenCalledWith({
        where: { id: 'ship1', status: 'PACKED' },
        data: { status: 'OUT_FOR_DELIVERY', dispatchedAt: expect.any(Date) },
      });
      expect(tx.shipmentStatusEvent.create).toHaveBeenCalledWith({
        data: { shipmentId: 'ship1', from: 'PACKED', to: 'OUT_FOR_DELIVERY', actorId: 'admin1', reason: 'Rider Kofi' },
      });
    });

    it('writes no event when another request moved the shipment first', async () => {
      tx.shipment.updateMany.mockResolvedValue({ count: 0 });

      expect(await repository.transitionShipment(tx as any, 'ship1', 'PACKED' as any, 'DELIVERED' as any)).toBeNull();
      expect(tx.shipmentStatusEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('transitionStatus', () => {
    const tx = {
      $queryRaw: jest.fn(),
      order: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      orderStatusEvent: { create: jest.fn() },
    };

    beforeEach(() => jest.resetAllMocks());

    it('moves the order only from the allowed statuses, records the event and returns it', async () => {
      const updated = { ...mockOrder, status: 'CANCELLED' };
      tx.$queryRaw.mockResolvedValue([{ status: 'CONFIRMED' }]);
      tx.order.updateMany.mockResolvedValue({ count: 1 });
      tx.order.findUniqueOrThrow.mockResolvedValue(updated);

      const result = await repository.transitionStatus(
        tx as any,
        'order1',
        'CANCELLED' as any,
        ['PLACED', 'CONFIRMED'] as any,
        { actorId: 'admin1', reason: 'Out of stock' },
      );

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order1', status: 'CONFIRMED', deleted: false },
        data: { status: 'CANCELLED' },
      });
      expect(tx.orderStatusEvent.create).toHaveBeenCalledWith({
        data: { orderId: 'order1', from: 'CONFIRMED', to: 'CANCELLED', actorId: 'admin1', reason: 'Out of stock' },
      });
      expect(result).toEqual(updated);
    });

    it('returns null and writes nothing when the order was no longer in an allowed status', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'COMPLETED' }]);

      const result = await repository.transitionStatus(tx as any, 'order1', 'CANCELLED' as any, ['PLACED'] as any);

      expect(result).toBeNull();
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderStatusEvent.create).not.toHaveBeenCalled();
      expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('refuses a move the order table does not have, before touching the database', async () => {
      await expect(
        repository.transitionStatus(tx as any, 'order1', 'IN_FULFILMENT' as any, ['CANCELLED'] as any),
      ).rejects.toThrow('Order table has no CANCELLED -> IN_FULFILMENT transition');
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('rethrows database errors', async () => {
      tx.$queryRaw.mockResolvedValue([{ status: 'CONFIRMED' }]);
      tx.order.updateMany.mockRejectedValue(new Error('DB error'));

      await expect(
        repository.transitionStatus(tx as any, 'order1', 'IN_FULFILMENT' as any, ['CONFIRMED'] as any),
      ).rejects.toThrow('DB error');
    });
  });

  describe('softDelete', () => {
    const tx = { order: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() } };

    beforeEach(() => jest.resetAllMocks());

    it('should soft delete a finished order that is not already deleted', async () => {
      const deleted = { ...mockOrder, deleted: true, deletedAt: fixedDate };
      tx.order.updateMany.mockResolvedValue({ count: 1 });
      tx.order.findUniqueOrThrow.mockResolvedValue(deleted);

      const result = await repository.softDelete(tx as any, 'order1', ['COMPLETED', 'CANCELLED'] as any);

      expect(result).toEqual(deleted);
      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order1', deleted: false, status: { in: ['COMPLETED', 'CANCELLED'] } },
          data: expect.objectContaining({ deleted: true }),
        }),
      );
    });

    it('returns null when the order was already deleted or is not finished', async () => {
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      expect(await repository.softDelete(tx as any, 'order1', ['COMPLETED'] as any)).toBeNull();
    });
  });

  describe('findAddressForUser', () => {
    it('should find an address for a specific user', async () => {
      const mockAddress = { id: 'addr1', userId: 'user1' } as unknown as Address;
      mockPrismaAddress.findFirst.mockResolvedValue(mockAddress);

      const result = await repository.findAddressForUser('addr1', 'user1');

      expect(result).toEqual(mockAddress);
      expect(mockPrismaAddress.findFirst).toHaveBeenCalledWith({
        where: { id: 'addr1', userId: 'user1' },
      });
    });
  });

  describe('findUserById', () => {
    it('should find a user by ID', async () => {
      const mockUser = { id: 'user1', email: 'user@example.com' } as unknown as User;
      mockPrismaUser.findUnique.mockResolvedValue(mockUser);

      const result = await repository.findUserById('user1');

      expect(result).toEqual(mockUser);
    });
  });

  describe('lockSellableVariant', () => {
    it('share-locks the variant and its product only while both are on sale', async () => {
      const mockTx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'var1' }]) };

      await expect(repository.lockSellableVariant(mockTx as any, 'var1')).resolves.toBe(true);

      const [sql, variantId] = mockTx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
      const query = sql.join('?');
      expect(variantId).toBe('var1');
      expect(query).toContain(`v."isActive" AND p."isActive" AND p.status = 'PUBLISHED'`);
      expect(query).toContain('FOR SHARE OF v, p');
    });

    it('reports a variant taken off sale', async () => {
      const mockTx = { $queryRaw: jest.fn().mockResolvedValue([]) };

      await expect(repository.lockSellableVariant(mockTx as any, 'var1')).resolves.toBe(false);
    });
  });

  describe('findVariant', () => {
    it('should find a variant with its product and stock levels by ID', async () => {
      const mockVariant = { id: 'var1', sku: 'TSHIRT-M', product: { id: 'prod1', name: 'T-Shirt' } };
      mockPrismaVariant.findUnique.mockResolvedValue(mockVariant);

      const result = await repository.findVariant('var1');

      expect(result).toEqual(mockVariant);
      expect(mockPrismaVariant.findUnique).toHaveBeenCalledWith({
        where: { id: 'var1' },
        include: {
          product: true,
          stockLevels: {
            where: { location: SERVING_LOCATION },
            select: { onHand: true, reserved: true, locationId: true },
          },
        },
      });
    });
  });

  describe('clearCartItems', () => {
    it('should clear all cart items via transaction', async () => {
      const mockTx = { cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) } };

      await repository.clearCartItems(mockTx as any, 'cart1');

      expect(mockTx.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart1' } });
    });
  });

  describe('runTransaction', () => {
    it('should delegate to prisma.$transaction', async () => {
      const fn = jest.fn().mockResolvedValue('result');
      mockPrisma.$transaction.mockImplementation((cb: any) => cb({}));

      await repository.runTransaction(fn);

      expect(mockPrisma.$transaction).toHaveBeenCalledWith(fn);
    });
  });

  describe('runWithAdvisoryLock', () => {
    const tx = { $queryRaw: jest.fn() };

    beforeEach(() => {
      jest.resetAllMocks();
      mockPrisma.$transaction.mockImplementation((cb: any) => cb(tx));
    });

    it('runs the job and returns its result when the lock is free', async () => {
      tx.$queryRaw.mockResolvedValue([{ locked: true }]);
      const job = jest.fn().mockResolvedValue(3);

      await expect(repository.runWithAdvisoryLock(42, 60_000, job)).resolves.toBe(3);
      expect(job).toHaveBeenCalledTimes(1);
    });

    it('skips the job and returns null when another process holds the lock', async () => {
      tx.$queryRaw.mockResolvedValue([{ locked: false }]);
      const job = jest.fn();

      await expect(repository.runWithAdvisoryLock(42, 60_000, job)).resolves.toBeNull();
      expect(job).not.toHaveBeenCalled();
    });
  });
});
