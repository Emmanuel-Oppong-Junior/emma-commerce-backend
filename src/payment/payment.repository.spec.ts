import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentRepository } from './payment.repository';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersRepository } from '../order/order.repository';
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
  findUniqueOrThrow: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrismaIntent = {
  upsert: jest.fn(),
  update: jest.fn(),
};

const mockPrismaRefund = {
  create: jest.fn(),
};

const mockOrdersRepository = {
  transitionStatus: jest.fn(),
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
  refund: mockPrismaRefund,
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
      providers: [
        PaymentRepository,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrdersRepository, useValue: mockOrdersRepository },
      ],
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

  describe('settleAttempt', () => {
    const success = { reference: 'txn_123', status: 'success', amount: 10000, currency: 'GHS' };
    const details = { reference: 'txn_123', status: 'success' };
    const locked = {
      ...mockAttempt,
      intent: { id: 'intent1', status: 'PENDING', orderId: 'order1', order: mockOrder },
    };

    beforeEach(() => {
      mockPrismaAttempt.findUniqueOrThrow
        .mockResolvedValueOnce({ intent: { orderId: 'order1' } })
        .mockResolvedValueOnce(locked)
        .mockResolvedValue({ ...mockAttempt, status: 'COMPLETED' });
      mockPrismaAttempt.updateMany.mockResolvedValue({ count: 1 });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: 'PROCESSING' });
      mockPrismaRefund.create.mockResolvedValue({ id: 'refund1' });
    });

    it('locks the order and decides against the locked attempt, intent and order', async () => {
      const decide = jest.fn().mockReturnValue({ kind: 'settled' });

      await repository.settleAttempt('pay1', success, details, decide);

      expect(mockTx.$queryRaw).toHaveBeenCalled();
      expect(decide).toHaveBeenCalledWith({
        status: 'PENDING',
        amount: mockAttempt.amount,
        currency: 'GHS',
        intentStatus: 'PENDING',
        order: mockOrder,
      });
    });

    it('writes nothing for an attempt that is already settled', async () => {
      const result = await repository.settleAttempt('pay1', success, details, () => ({ kind: 'settled' }));

      expect(result.outcome).toEqual({ kind: 'settled' });
      expect(mockPrismaAttempt.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaAttempt.update).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
      expect(mockPrismaRefund.create).not.toHaveBeenCalled();
    });

    it('claims the open attempt, marks the intent PAID and moves the order only from PENDING to PROCESSING', async () => {
      const result = await repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay1', status: { in: ['PENDING', 'ABANDONED'] } },
        data: { status: 'COMPLETED', rawStatus: 'success', providerDetails: details },
      });
      expect(mockPrismaIntent.update).toHaveBeenCalledWith({ where: { id: 'intent1' }, data: { status: 'PAID' } });
      expect(mockOrdersRepository.transitionStatus).toHaveBeenCalledWith(mockTx, 'order1', 'PROCESSING', ['PENDING']);
      expect(mockPrismaRefund.create).not.toHaveBeenCalled();
      expect(result.attempt.status).toBe('COMPLETED');
    });

    it('rolls back if the order left PENDING under the lock', async () => {
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }))).rejects.toThrow(
        ConflictException,
      );
    });

    it('stops before any side effect when the claim finds the attempt already settled', async () => {
      mockPrismaAttempt.updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }))).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrismaIntent.update).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('fails the attempt without touching the intent or the order', async () => {
      await repository.settleAttempt('pay1', { ...success, status: 'failed' }, details, () => ({ kind: 'failed' }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED', rawStatus: 'failed', providerDetails: details } }),
      );
      expect(mockPrismaIntent.update).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('only records the raw status while the provider has not decided', async () => {
      mockPrismaAttempt.update.mockResolvedValue({ ...mockAttempt, rawStatus: 'ongoing' });

      await repository.settleAttempt('pay1', { ...success, status: 'ongoing' }, details, () => ({
        kind: 'unresolved',
      }));

      expect(mockPrismaAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pay1' }, data: { rawStatus: 'ongoing' } }),
      );
      expect(mockPrismaAttempt.updateMany).not.toHaveBeenCalled();
    });

    it('records a review case on the attempt and queues one refund of the captured amount, order untouched', async () => {
      const result = await repository.settleAttempt('pay1', { ...success, amount: 9999 }, details, () => ({
        kind: 'review',
        reason: 'AMOUNT_MISMATCH',
        attemptStatus: 'FAILED',
      }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'FAILED', rawStatus: 'success', providerDetails: details, reviewReason: 'AMOUNT_MISMATCH' },
        }),
      );
      expect(mockPrismaRefund.create).toHaveBeenCalledWith({
        data: {
          attemptId: 'pay1',
          amount: new Prisma.Decimal('99.99'),
          currency: 'GHS',
          idempotencyKey: 'auto-refund:pay1',
        },
      });
      expect(mockPrismaIntent.update).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
      expect(result.refundId).toBe('refund1');
    });

    it('keeps a correct charge for an order that cannot take it as COMPLETED, flagged', async () => {
      await repository.settleAttempt('pay1', success, details, () => ({
        kind: 'review',
        reason: 'ORDER_NOT_PAYABLE',
        attemptStatus: 'COMPLETED',
      }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED', reviewReason: 'ORDER_NOT_PAYABLE' }),
        }),
      );
      expect(mockPrismaRefund.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: new Prisma.Decimal(100), idempotencyKey: 'auto-refund:pay1' }),
      });
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
    });
  });
});
