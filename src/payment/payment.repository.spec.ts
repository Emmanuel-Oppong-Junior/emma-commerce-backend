import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentRepository } from './payment.repository';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersRepository } from '../order/order.repository';
import { StoreRepository } from '../store/store.repository';
import { OutboxService } from '../outbox/outbox.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { Order, Prisma } from '../generated/prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'PENDING',
  grandTotal: new Prisma.Decimal(100),
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
  provider: 'PAYSTACK',
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
  updateMany: jest.fn(),
};

const mockPrismaRefund = {
  create: jest.fn(),
};

const mockOrdersRepository = {
  transitionStatus: jest.fn(),
  transitionShipment: jest.fn(),
};

const mockStoreRepository = {
  findCurrency: jest.fn(),
};

const mockOutbox = { record: jest.fn() };

const mockPrismaCashCollection = {
  create: jest.fn(),
};

const mockPrismaOrder = {
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrismaUser = { findUnique: jest.fn() };

const mockTx = {
  user: mockPrismaUser,
  paymentAttempt: mockPrismaAttempt,
  paymentIntent: mockPrismaIntent,
  cashCollection: mockPrismaCashCollection,
  refund: mockPrismaRefund,
  order: mockPrismaOrder,
  $queryRaw: jest.fn(),
};

const mockStockLedger = { consumeOrder: jest.fn() };

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
        { provide: StoreRepository, useValue: mockStoreRepository },
        { provide: OutboxService, useValue: mockOutbox },
        { provide: StockLedgerService, useValue: mockStockLedger },
        {
          provide: SerialUnitsService,
          useValue: { releaseOrder: jest.fn(), startWarranty: jest.fn() },
        },
      ],
    }).compile();

    repository = module.get<PaymentRepository>(PaymentRepository);
    jest.clearAllMocks();
    mockStoreRepository.findCurrency.mockResolvedValue('GHS');
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
          create: { orderId: 'order1', amount: mockOrder.grandTotal, currency: 'GHS' },
        }),
      );
      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith({
        where: { intentId: 'intent1', status: 'PENDING' },
        data: { status: 'CANCELLED' },
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

    it('opens the intent in the store currency, read on the same transaction', async () => {
      mockStoreRepository.findCurrency.mockResolvedValue('USD');

      await repository.openAttempt(request, allowAll);

      expect(mockStoreRepository.findCurrency).toHaveBeenCalledWith(mockTx);
      expect(mockPrismaIntent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { orderId: 'order1', amount: mockOrder.grandTotal, currency: 'USD' } }),
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
    const amount = new Prisma.Decimal(100);
    const shippedCod = {
      ...mockOrder,
      status: 'IN_FULFILMENT',
      paymentMethod: 'CASH_ON_DELIVERY',
      paymentIntent: null,
      shipments: [{ id: 'ship1', status: 'OUT_FOR_DELIVERY' }],
    };
    const collection = { id: 'cc1', orderId: 'order1', attemptId: 'pay1', amount, currency: 'GHS' };
    const completed = {
      ...mockAttempt,
      provider: 'CASH_ON_DELIVERY',
      channel: 'CASH_ON_DELIVERY',
      status: 'CAPTURED',
    };
    const allowAll = jest.fn();
    const onRecorded = jest.fn();
    const collectedAt = new Date('2026-11-22T10:00:00Z');
    const request = { recordedById: 'admin1', riderId: 'rider1', collectedAt };

    beforeEach(() => {
      mockPrismaOrder.findUnique.mockResolvedValue(shippedCod);
      mockPrismaUser.findUnique.mockResolvedValue({
        isActive: true,
        storeMemberships: [{ role: { key: 'CASHIER', permissions: ['order.view'] } }],
      });
      mockPrismaIntent.upsert.mockResolvedValue({ id: 'intent1' });
      mockPrismaAttempt.create.mockResolvedValue({ id: 'pay1' });
      mockPrismaCashCollection.create.mockResolvedValue(collection);
      mockPrismaAttempt.findUniqueOrThrow.mockResolvedValue(completed);
      mockPrismaIntent.updateMany.mockResolvedValue({ count: 1 });
      mockOrdersRepository.transitionShipment.mockResolvedValue({
        id: 'ship1',
        status: 'DELIVERED',
        carrier: null,
        trackingNumber: null,
        deliveredAt: new Date('2026-11-23T10:00:00Z'),
        items: [{ orderItemId: 'item1', quantity: 1 }],
      });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...shippedCod, status: 'COMPLETED' });
    });

    it('locks the order and re-checks it before writing anything', async () => {
      const refusal = new ConflictException('not collectable');
      const refuse = jest.fn(() => {
        throw refusal;
      });

      await expect(repository.recordCashCollection('order1', request, refuse, onRecorded)).rejects.toBe(refusal);

      expect(mockTx.$queryRaw).toHaveBeenCalled();
      expect(refuse).toHaveBeenCalledWith(shippedCod, { isActive: true, isStaff: true, isRider: false });
      expect(mockPrismaIntent.upsert).not.toHaveBeenCalled();
      expect(mockPrismaAttempt.create).not.toHaveBeenCalled();
      expect(mockPrismaCashCollection.create).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
      expect(onRecorded).not.toHaveBeenCalled();
    });

    it('captures the intent and records a captured cash attempt with its collection for the grand total', async () => {
      await repository.recordCashCollection('order1', request, allowAll, onRecorded);

      expect(mockPrismaIntent.upsert).toHaveBeenCalledWith({
        where: { orderId: 'order1' },
        create: { orderId: 'order1', amount, currency: 'GHS', status: 'PENDING' },
        update: {},
      });
      expect(mockPrismaIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'intent1', status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CAPTURED' },
      });
      expect(mockPrismaAttempt.create).toHaveBeenCalledWith({
        data: {
          intentId: 'intent1',
          provider: 'CASH_ON_DELIVERY',
          amount,
          currency: 'GHS',
          channel: 'CASH_ON_DELIVERY',
          status: 'CAPTURED',
        },
      });
      expect(mockPrismaCashCollection.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order1',
          attemptId: 'pay1',
          amount,
          currency: 'GHS',
          recordedById: 'admin1',
          riderId: 'rider1',
          collectedAt,
        },
      });
    });

    it('hands the re-check a rider without a store membership as not staff, and an unknown rider as null', async () => {
      const check = jest.fn();
      mockPrismaUser.findUnique.mockResolvedValueOnce({ isActive: true, storeMemberships: [] });
      await repository.recordCashCollection('order1', request, check, onRecorded);
      mockPrismaUser.findUnique.mockResolvedValueOnce(null);
      await repository.recordCashCollection('order1', request, check, onRecorded);

      expect(check).toHaveBeenNthCalledWith(1, shippedCod, { isActive: true, isStaff: false, isRider: false });
      expect(check).toHaveBeenNthCalledWith(2, shippedCod, null);
    });

    it('hands the re-check a Rider-role member as a rider, and the Owner as not one', async () => {
      const check = jest.fn();
      mockPrismaUser.findUnique.mockResolvedValueOnce({
        isActive: true,
        storeMemberships: [{ role: { key: 'RIDER', permissions: ['delivery.ride'] } }],
      });
      await repository.recordCashCollection('order1', request, check, onRecorded);
      mockPrismaUser.findUnique.mockResolvedValueOnce({
        isActive: true,
        storeMemberships: [{ role: { key: 'OWNER', permissions: ['delivery.ride'] } }],
      });
      await repository.recordCashCollection('order1', request, check, onRecorded);

      expect(check).toHaveBeenNthCalledWith(1, shippedCod, { isActive: true, isStaff: true, isRider: true });
      expect(check).toHaveBeenNthCalledWith(2, shippedCod, { isActive: true, isStaff: true, isRider: false });
    });

    it('delivers the shipment and completes the order only from the status it was locked in, then hands the result to onRecorded', async () => {
      const result = await repository.recordCashCollection('order1', request, allowAll, onRecorded);

      const context = { actorId: 'admin1', reason: 'Cash collected on delivery' };
      expect(mockOrdersRepository.transitionShipment).toHaveBeenCalledWith(
        mockTx,
        'ship1',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        context,
      );
      expect(mockOrdersRepository.transitionStatus).toHaveBeenCalledWith(
        mockTx,
        'order1',
        'COMPLETED',
        ['IN_FULFILMENT'],
        context,
      );
      expect(mockOutbox.record).toHaveBeenCalledWith(mockTx, {
        type: 'shipment.status_changed.v1',
        aggregateId: 'order1',
        payload: {
          orderId: 'order1',
          shipmentId: 'ship1',
          status: 'DELIVERED',
          trackingNumber: null,
          carrier: null,
          items: [{ orderItemId: 'item1', quantity: 1 }],
        },
      });
      expect(mockOutbox.record).toHaveBeenCalledWith(mockTx, {
        type: 'order.status_changed.v2',
        aggregateId: 'order1',
        payload: { orderId: 'order1', from: 'IN_FULFILMENT', to: 'COMPLETED' },
      });
      expect(result).toEqual({
        attempt: expect.objectContaining({ id: 'pay1', status: 'CAPTURED' }),
        collection,
        from: 'IN_FULFILMENT',
      });
      expect(onRecorded).toHaveBeenCalledWith(mockTx, result);
    });

    it('rolls back if the order changed under the lock', async () => {
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(repository.recordCashCollection('order1', request, allowAll, onRecorded)).rejects.toThrow(
        ConflictException,
      );
      expect(onRecorded).not.toHaveBeenCalled();
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
        { ...mockAttempt, id: 'pay1', status: 'CANCELLED' },
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
        { ...mockAttempt, id: 'pay1', status: 'CAPTURED' },
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
        .mockResolvedValue({ ...mockAttempt, status: 'CAPTURED' });
      mockPrismaAttempt.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaIntent.updateMany.mockResolvedValue({ count: 1 });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: 'CONFIRMED' });
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

    it('claims the open attempt, captures the open intent and moves the order only from PLACED to CONFIRMED', async () => {
      const result = await repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay1', status: { in: ['PENDING', 'CANCELLED'] } },
        data: { status: 'CAPTURED', rawStatus: 'success', providerDetails: details },
      });
      expect(mockPrismaIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'intent1', status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'CAPTURED' },
      });
      expect(mockOrdersRepository.transitionStatus).toHaveBeenCalledWith(mockTx, 'order1', 'CONFIRMED', ['PLACED'], {
        reason: 'Payment captured',
      });
      expect(mockPrismaRefund.create).not.toHaveBeenCalled();
      expect(result.attempt.status).toBe('CAPTURED');
    });

    it('consumes the order stock reservations in the settlement transaction, after the order moved to CONFIRMED', async () => {
      await repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }));

      expect(mockStockLedger.consumeOrder).toHaveBeenCalledWith(mockTx, 'order1');
      expect(mockOrdersRepository.transitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        mockStockLedger.consumeOrder.mock.invocationCallOrder[0],
      );
    });

    it.each([
      ['settled', { kind: 'settled' }],
      ['failed', { kind: 'failed' }],
      [
        'sent to review (a payment for an expired order)',
        { kind: 'review', reason: 'ORDER_NOT_PAYABLE', attemptStatus: 'CAPTURED' },
      ],
    ])('consumes no stock when the attempt is %s', async (_label, outcome) => {
      await repository.settleAttempt('pay1', success, details, () => outcome as never);

      expect(mockStockLedger.consumeOrder).not.toHaveBeenCalled();
    });

    it('records payment.succeeded.v1 in the settlement transaction, after the order moved to CONFIRMED', async () => {
      await repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }));

      expect(mockOutbox.record).toHaveBeenCalledTimes(1);
      expect(mockOutbox.record).toHaveBeenCalledWith(mockTx, {
        type: 'payment.succeeded.v1',
        aggregateId: 'order1',
        payload: { orderId: 'order1', paymentId: 'pay1', amount: '100.00' },
      });
      expect(mockOrdersRepository.transitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        mockOutbox.record.mock.invocationCallOrder[0],
      );
    });

    it.each([
      ['already settled (repeat webhook, racing request)', { kind: 'settled' }],
      ['undecided', { kind: 'unresolved' }],
      ['failed', { kind: 'failed' }],
      ['sent to review', { kind: 'review', reason: 'AMOUNT_MISMATCH', attemptStatus: 'FAILED' }],
    ])('records no payment event when the attempt is %s', async (_label, outcome) => {
      mockPrismaAttempt.update.mockResolvedValue({ ...mockAttempt, rawStatus: 'ongoing' });

      await repository.settleAttempt('pay1', { ...success, status: 'ongoing' }, details, () => outcome as never);

      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('records no payment event when the order left PLACED, so the rollback leaves nothing to send', async () => {
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(repository.settleAttempt('pay1', success, details, () => ({ kind: 'paid' }))).rejects.toThrow(
        ConflictException,
      );
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('rolls back if the order left PLACED under the lock', async () => {
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
      expect(mockPrismaIntent.updateMany).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('fails the attempt and marks the intent FAILED only while it is open, without touching the order', async () => {
      await repository.settleAttempt('pay1', { ...success, status: 'failed' }, details, () => ({ kind: 'failed' }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED', rawStatus: 'failed', providerDetails: details } }),
      );
      expect(mockPrismaIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'intent1', status: { in: ['PENDING'] } },
        data: { status: 'FAILED' },
      });
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

    it('writes nothing when the provider repeats the undecided status already recorded', async () => {
      mockPrismaAttempt.findUniqueOrThrow.mockReset();
      mockPrismaAttempt.findUniqueOrThrow
        .mockResolvedValueOnce({ intent: { orderId: 'order1' } })
        .mockResolvedValueOnce({ ...locked, rawStatus: 'abandoned' });

      const result = await repository.settleAttempt('pay1', { ...success, status: 'abandoned' }, details, () => ({
        kind: 'unresolved',
      }));

      expect(result.outcome).toEqual({ kind: 'unresolved' });
      expect(mockPrismaAttempt.update).not.toHaveBeenCalled();
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
          reason: 'PAYMENT_NOT_ACCEPTED',
        },
      });
      expect(mockPrismaIntent.updateMany).not.toHaveBeenCalled();
      expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
      expect(result.refundId).toBe('refund1');
    });

    it('keeps a correct charge for a closed order as CAPTURED, flagged, and moves the order to PAYMENT_REVIEW', async () => {
      await repository.settleAttempt('pay1', success, details, () => ({
        kind: 'review',
        reason: 'ORDER_NOT_PAYABLE',
        attemptStatus: 'CAPTURED',
      }));

      expect(mockPrismaAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CAPTURED', reviewReason: 'ORDER_NOT_PAYABLE' }),
        }),
      );
      expect(mockPrismaRefund.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: new Prisma.Decimal(100), idempotencyKey: 'auto-refund:pay1' }),
      });
      expect(mockOrdersRepository.transitionStatus).toHaveBeenCalledWith(
        mockTx,
        'order1',
        'PAYMENT_REVIEW',
        ['CANCELLED', 'EXPIRED'],
        { reason: 'Payment pay1 captured after the order closed; refund queued' },
      );
    });
  });
});
