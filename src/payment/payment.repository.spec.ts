import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentRepository } from './payment.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Order, Prisma } from '@prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'PENDING',
  totalAmount: new Prisma.Decimal(100),
  deleted: false,
} as unknown as Order;

const mockAttempt = {
  id: 'pay1',
  intentId: 'intent1',
  provider: 'PAYSTACK',
  reference: 'txn_123',
  amount: new Prisma.Decimal(100),
  currency: 'GHS',
  status: 'PENDING',
  rawStatus: null,
  channel: 'CARD',
  providerDetails: null,
  deleted: false,
  deletedAt: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  intent: { orderId: 'order1', order: mockOrder },
};

const mockPayment = {
  id: 'pay1',
  orderId: 'order1',
  order: mockOrder,
  amount: new Prisma.Decimal(100),
  currency: 'GHS',
  paymentMethod: 'CARD',
  status: 'PENDING',
  transactionId: 'txn_123',
  paymentDetails: null,
  deleted: false,
  deletedAt: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
};

const mockPrismaAttempt = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrismaIntent = {
  upsert: jest.fn(),
  update: jest.fn(),
};

const mockPrismaCashCollection = {
  create: jest.fn(),
};

const mockPrismaOrder = {
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

const mockTx = {
  paymentAttempt: mockPrismaAttempt,
  paymentIntent: mockPrismaIntent,
  cashCollection: mockPrismaCashCollection,
  order: mockPrismaOrder,
  $queryRaw: jest.fn(),
};

const mockPrisma = {
  ...mockTx,
  $transaction: jest.fn((work: (tx: typeof mockTx) => unknown) => work(mockTx)),
};

describe('PaymentRepository', () => {
  let repository: PaymentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<PaymentRepository>(PaymentRepository);
    jest.clearAllMocks();
  });

  describe('openAttempt', () => {
    const request = {
      orderId: 'order1',
      provider: 'PAYSTACK' as const,
      channel: 'CARD',
      reference: 'txn_123',
      idempotencyKey: 'key-1',
    };
    const payableOrder = { ...mockOrder, user: { email: 'user@example.com' }, paymentIntent: null };
    const allowAll = jest.fn();

    beforeEach(() => {
      mockPrismaOrder.findUnique.mockResolvedValue(payableOrder);
      mockPrismaAttempt.findFirst.mockResolvedValue(null);
      mockPrismaIntent.upsert.mockResolvedValue({ id: 'intent1', amount: new Prisma.Decimal(100), currency: 'GHS' });
      mockPrismaAttempt.create.mockResolvedValue(mockAttempt);
    });

    it('locks the order and re-checks it before writing anything', async () => {
      const refusal = new Error('not payable');
      const refuse = jest.fn(() => {
        throw refusal;
      });

      await expect(repository.openAttempt(request, refuse)).rejects.toBe(refusal);

      expect(mockTx.$queryRaw).toHaveBeenCalled();
      expect(refuse).toHaveBeenCalledWith(payableOrder);
      expect(mockPrismaAttempt.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaAttempt.create).not.toHaveBeenCalled();
    });

    it('abandons other pending attempts and records a new attempt priced from the intent', async () => {
      const result = await repository.openAttempt(request, allowAll);

      expect(result).toEqual({ created: true, attempt: mockPayment });
      expect(mockPrismaIntent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 'order1' },
          create: { orderId: 'order1', amount: mockOrder.totalAmount, currency: 'GHS' },
        }),
      );
      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith({
        where: { intentId: 'intent1', status: 'PENDING' },
        data: { status: 'ABANDONED' },
      });
      expect(mockPrismaAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            intentId: 'intent1',
            reference: 'txn_123',
            idempotencyKey: 'key-1',
            amount: new Prisma.Decimal(100),
            currency: 'GHS',
            status: 'PENDING',
          }),
        }),
      );
    });

    it('returns the attempt already opened under the same idempotency key without writing', async () => {
      mockPrismaAttempt.findFirst.mockResolvedValue({ ...mockAttempt, authorizationUrl: 'https://checkout.test/x' });

      const result = await repository.openAttempt(request, allowAll);

      expect(result).toEqual({ created: false, attempt: mockPayment, authorizationUrl: 'https://checkout.test/x' });
      expect(mockPrismaAttempt.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { idempotencyKey: 'key-1', intent: { orderId: 'order1' } } }),
      );
      expect(mockPrismaAttempt.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaAttempt.create).not.toHaveBeenCalled();
    });

    it('does not look up a key when none was sent', async () => {
      await repository.openAttempt({ ...request, idempotencyKey: undefined }, allowAll);

      expect(mockPrismaAttempt.findFirst).not.toHaveBeenCalled();
      expect(mockPrismaAttempt.create).toHaveBeenCalled();
    });
  });

  describe('recordCheckout', () => {
    it('stores the checkout URL and provider details on the attempt', async () => {
      await repository.recordCheckout('pay1', 'https://checkout.test/x', { reference: 'txn_123' });

      expect(mockPrismaAttempt.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: { authorizationUrl: 'https://checkout.test/x', providerDetails: { reference: 'txn_123' } },
      });
    });
  });

  describe('recordCashCollection', () => {
    it('records a completed cash-on-delivery attempt and its cash collection', async () => {
      const amount = new Prisma.Decimal(100);
      mockPrismaIntent.upsert.mockResolvedValue({ id: 'intent1' });
      mockPrismaAttempt.create.mockResolvedValue({ ...mockAttempt, provider: 'CASH_ON_DELIVERY', status: 'COMPLETED' });

      await repository.recordCashCollection('order1', amount, 'admin1');

      expect(mockPrismaIntent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: 'order1' }, update: { status: 'PAID' } }),
      );
      expect(mockPrismaAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ provider: 'CASH_ON_DELIVERY', status: 'COMPLETED', amount }),
        }),
      );
      expect(mockPrismaCashCollection.create).toHaveBeenCalledWith({
        data: { orderId: 'order1', attemptId: 'pay1', amount, recordedById: 'admin1' },
      });
    });
  });

  describe('findById', () => {
    it('should find a payment by ID', async () => {
      mockPrismaAttempt.findUnique.mockResolvedValue(mockAttempt);

      const result = await repository.findById('pay1');

      expect(result).toEqual(mockPayment);
      expect(mockPrismaAttempt.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay1', deleted: false },
        include: { intent: { include: { order: true } } },
      });
    });

    it('should return null if not found', async () => {
      mockPrismaAttempt.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByReference', () => {
    it('should find a payment by transaction reference', async () => {
      mockPrismaAttempt.findFirst.mockResolvedValue({ ...mockAttempt, intent: { orderId: 'order1' } });

      const result = await repository.findByReference('txn_123');

      expect(result).toEqual(expect.objectContaining({ id: 'pay1', orderId: 'order1', transactionId: 'txn_123' }));
      expect(mockPrismaAttempt.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { reference: 'txn_123', deleted: false } }),
      );
    });

    it('should return null if not found', async () => {
      mockPrismaAttempt.findFirst.mockResolvedValue(null);

      const result = await repository.findByReference('invalid_ref');

      expect(result).toBeNull();
    });
  });

  describe('findByOrderId', () => {
    it('returns the newest attempt of the order', async () => {
      mockPrismaAttempt.findMany.mockResolvedValue([
        { ...mockAttempt, id: 'pay2' },
        { ...mockAttempt, id: 'pay1', status: 'ABANDONED' },
      ]);

      const result = await repository.findByOrderId('order1');

      expect(result?.id).toBe('pay2');
      expect(mockPrismaAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { intent: { orderId: 'order1' } }, orderBy: { createdAt: 'desc' } }),
      );
    });

    it('prefers a completed attempt over newer ones', async () => {
      mockPrismaAttempt.findMany.mockResolvedValue([
        { ...mockAttempt, id: 'pay2', status: 'PENDING' },
        { ...mockAttempt, id: 'pay1', status: 'COMPLETED' },
      ]);

      const result = await repository.findByOrderId('order1');

      expect(result?.id).toBe('pay1');
    });

    it('returns null when the order has no attempt', async () => {
      mockPrismaAttempt.findMany.mockResolvedValue([]);

      expect(await repository.findByOrderId('order1')).toBeNull();
    });
  });

  describe('findByUser', () => {
    it('should return all payments for a user', async () => {
      mockPrismaAttempt.findMany.mockResolvedValue([mockAttempt]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockPayment]);
      expect(mockPrismaAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { intent: { order: { userId: 'user1' } }, deleted: false } }),
      );
    });
  });

  describe('update', () => {
    it('should update a payment', async () => {
      mockPrismaAttempt.update.mockResolvedValue({ ...mockAttempt, deleted: true });

      const result = await repository.update('pay1', { deleted: true });

      expect(result).toEqual({ ...mockPayment, deleted: true });
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaAttempt.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaAttempt.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('pay1', {})).rejects.toThrow('DB error');
    });
  });

  describe('markInitializationFailed', () => {
    it('fails the attempt only while it is still pending and frees its idempotency key', async () => {
      mockPrismaAttempt.updateMany.mockResolvedValue({ count: 1 });

      await repository.markInitializationFailed('pay1');

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay1', status: 'PENDING' },
        data: { status: 'FAILED', rawStatus: 'initialize_failed', idempotencyKey: null },
      });
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
      const updated = { ...mockAttempt, status: 'FAILED', providerDetails: { gateway: 'paystack' } };
      mockPrismaAttempt.update.mockResolvedValue(updated);

      const result = await repository.updatePaymentWithStatus('pay1', 'FAILED', { gateway: 'paystack' });

      expect(result).toEqual({ ...mockPayment, status: 'FAILED', paymentDetails: { gateway: 'paystack' } });
      expect(mockPrismaAttempt.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: { status: 'FAILED', providerDetails: { gateway: 'paystack' } },
        include: { intent: { include: { order: true } } },
      });
      expect(mockPrismaIntent.update).not.toHaveBeenCalled();
    });

    it("marks the order's payment intent PAID when the attempt completes", async () => {
      mockPrismaAttempt.update.mockResolvedValue({ ...mockAttempt, status: 'COMPLETED' });

      await repository.updatePaymentWithStatus('pay1', 'COMPLETED', {});

      expect(mockPrismaIntent.update).toHaveBeenCalledWith({ where: { id: 'intent1' }, data: { status: 'PAID' } });
    });
  });
});
