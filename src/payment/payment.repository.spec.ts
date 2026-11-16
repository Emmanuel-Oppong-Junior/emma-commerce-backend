import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentRepository } from './payment.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Order, Payment, Prisma } from '@prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockPayment = {
  id: 'pay1',
  orderId: 'order1',
  amount: new Prisma.Decimal(100),
  status: 'PENDING',
  transactionId: 'txn_123',
  paymentMethod: 'CARD',
  paymentDetails: null,
  deleted: false,
  createdAt: fixedDate,
  updatedAt: fixedDate,
} as unknown as Payment;

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'PENDING',
  totalAmount: new Prisma.Decimal(100),
  deleted: false,
} as unknown as Order;

const mockPrismaPayment = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaOrder = {
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrisma = { payment: mockPrismaPayment, order: mockPrismaOrder };

describe('PaymentRepository', () => {
  let repository: PaymentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<PaymentRepository>(PaymentRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a payment', async () => {
      mockPrismaPayment.create.mockResolvedValue(mockPayment);

      const result = await repository.create({ order: { connect: { id: 'order1' } } } as any);

      expect(result).toEqual(mockPayment);
    });
  });

  describe('findById', () => {
    it('should find a payment by ID', async () => {
      mockPrismaPayment.findUnique.mockResolvedValue(mockPayment);

      const result = await repository.findById('pay1');

      expect(result).toEqual(mockPayment);
      expect(mockPrismaPayment.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay1', deleted: false },
        include: { order: true },
      });
    });

    it('should return null if not found', async () => {
      mockPrismaPayment.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByReference', () => {
    it('should find a payment by transaction reference', async () => {
      mockPrismaPayment.findFirst.mockResolvedValue(mockPayment);

      const result = await repository.findByReference('txn_123');

      expect(result).toEqual(mockPayment);
      expect(mockPrismaPayment.findFirst).toHaveBeenCalledWith({
        where: { transactionId: 'txn_123', deleted: false },
      });
    });

    it('should return null if not found', async () => {
      mockPrismaPayment.findFirst.mockResolvedValue(null);

      const result = await repository.findByReference('invalid_ref');

      expect(result).toBeNull();
    });
  });

  describe('findByOrderId', () => {
    it('should find a payment by order ID', async () => {
      mockPrismaPayment.findUnique.mockResolvedValue(mockPayment);

      const result = await repository.findByOrderId('order1');

      expect(result).toEqual(mockPayment);
      expect(mockPrismaPayment.findUnique).toHaveBeenCalledWith({ where: { orderId: 'order1' } });
    });
  });

  describe('findByUser', () => {
    it('should return all payments for a user', async () => {
      mockPrismaPayment.findMany.mockResolvedValue([mockPayment]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockPayment]);
      expect(mockPrismaPayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { order: { userId: 'user1' }, deleted: false } }),
      );
    });
  });

  describe('update', () => {
    it('should update a payment', async () => {
      const updated = { ...mockPayment, status: 'SUCCESS' };
      mockPrismaPayment.update.mockResolvedValue(updated);

      const result = await repository.update('pay1', { status: 'SUCCESS' } as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaPayment.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaPayment.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('pay1', {})).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a payment', async () => {
      mockPrismaPayment.delete.mockResolvedValue(mockPayment);

      const result = await repository.delete('pay1');

      expect(result).toEqual(mockPayment);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaPayment.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaPayment.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('pay1')).rejects.toThrow('DB error');
    });
  });

  describe('findOrderWithUser', () => {
    it('should return an order with user', async () => {
      const orderWithUser = { ...mockOrder, user: { email: 'user@example.com' } };
      mockPrismaOrder.findUnique.mockResolvedValue(orderWithUser);

      const result = await repository.findOrderWithUser('order1');

      expect(result).toEqual(orderWithUser);
      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'order1' }, include: { user: true } }),
      );
    });

    it('should return null if order not found', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(null);

      const result = await repository.findOrderWithUser('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findOrderById', () => {
    it('should find an order by ID', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      const result = await repository.findOrderById('order1');

      expect(result).toEqual(mockOrder);
    });
  });

  describe('updateOrderStatus', () => {
    it('should update order status', async () => {
      mockPrismaOrder.updateMany.mockResolvedValue({ count: 1 });

      const result = await repository.updateOrderStatus('order1', 'CONFIRMED' as any);

      expect(mockPrismaOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'order1', status: 'PENDING' },
        data: { status: 'CONFIRMED' },
      });
      expect(result).toBe(true);
    });

    it('should leave a non-PENDING order unchanged and report it', async () => {
      mockPrismaOrder.updateMany.mockResolvedValue({ count: 0 });

      const result = await repository.updateOrderStatus('order1', 'PROCESSING');

      expect(result).toBe(false);
    });
  });

  describe('updatePaymentWithStatus', () => {
    it('should update payment status and details', async () => {
      const updated = { ...mockPayment, status: 'SUCCESS', paymentDetails: { gateway: 'paystack' } };
      mockPrismaPayment.update.mockResolvedValue(updated);

      const result = await repository.updatePaymentWithStatus('pay1', 'SUCCESS' as any, { gateway: 'paystack' });

      expect(result).toEqual(updated);
      expect(mockPrismaPayment.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: { status: 'SUCCESS', paymentDetails: { gateway: 'paystack' } },
        include: { order: true },
      });
    });
  });
});
