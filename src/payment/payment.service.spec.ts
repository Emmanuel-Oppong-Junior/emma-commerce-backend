import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, Prisma } from '../generated/prisma/client';
import { LoggerService } from '../commons/logger.service';
import { AuditService } from '../commons/audit.service';
import { PaystackClient } from './paystack.client';
import { StoreService } from '../store/store.service';

const mockPaystack = {
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
};

const mockPaymentRepository = {
  openAttempt: jest.fn(),
  recordCheckout: jest.fn(),
  markInitializationFailed: jest.fn(),
  findById: jest.fn(),
  findByReference: jest.fn(),
  findByOrderId: jest.fn(),
  findByUser: jest.fn(),
  update: jest.fn(),
  recordCashCollection: jest.fn(),
  findOrderWithUser: jest.fn(),
  findOrderById: jest.fn(),
  settleAttempt: jest.fn(),
};

const mockConfigService = {
  get: jest.fn(),
};

const mockLoggerService = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

const mockAuditService = {
  log: jest.fn(),
};

const mockStoreService = { getCurrency: jest.fn().mockResolvedValue('GHS') };

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('PaymentService', () => {
  let service: PaymentService;
  let paymentRepository: jest.Mocked<PaymentRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentRepository, useValue: mockPaymentRepository },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: PaystackClient, useValue: mockPaystack },
        { provide: StoreService, useValue: mockStoreService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    paymentRepository = module.get<PaymentRepository>(PaymentRepository) as jest.Mocked<PaymentRepository>;

    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'PAYSTACK_SECRET_KEY') return 'test_secret';
      if (key === 'PAYSTACK_CALLBACK_URL') return 'http://callback.test';
      return undefined;
    });

    jest.clearAllMocks();
  });

  describe('initiatePayment', () => {
    const userId = 'user1';
    const createPaymentDto: CreatePaymentDto = { orderId: 'order1', currency: 'GHS', paymentMethod: 'card' };
    const order = {
      id: 'order1',
      userId: 'user1',
      status: 'PLACED',
      deleted: false,
      paymentMethod: 'ONLINE',
      grandTotal: new Prisma.Decimal(1000),
      user: { email: 'test@example.com' },
      paymentIntent: null,
    };
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      amount: new Prisma.Decimal('1000.50'),
      currency: 'GHS',
      paymentMethod: 'card',
      status: PaymentStatus.PENDING,
      transactionId: 'order1-ref',
      paymentDetails: null,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const transaction = {
      reference: 'order1-ref',
      authorization_url: 'http://paystack.test/auth',
      access_code: 'acc_test_123',
    };

    const openAttemptAgainst = (current: unknown, opened: unknown) =>
      mockPaymentRepository.openAttempt.mockImplementation(
        async (_request: unknown, assertPayable: (order: unknown) => void) => {
          assertPayable(current);
          return opened;
        },
      );

    beforeEach(() => {
      mockPaymentRepository.findOrderWithUser.mockResolvedValue(order);
      openAttemptAgainst(order, { created: true, attempt: payment });
      mockPaystack.initializeTransaction.mockResolvedValue(transaction);
    });

    it('opens a pending attempt and a Paystack checkout for its reference, charging the attempt amount in GHS', async () => {
      const result = await service.initiatePayment(userId, { ...createPaymentDto, idempotencyKey: 'key-1' });

      expect(paymentRepository.openAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order1', idempotencyKey: 'key-1', provider: 'PAYSTACK', channel: 'card' }),
        expect.any(Function),
      );
      const { reference } = mockPaymentRepository.openAttempt.mock.calls[0][0];
      expect(reference).toMatch(/^order1-/);
      expect(mockPaystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@example.com', amount: 100050, currency: 'GHS', reference }),
      );
      expect(paymentRepository.recordCheckout).toHaveBeenCalledWith('pay1', 'http://paystack.test/auth', {
        reference: 'order1-ref',
        access_code: 'acc_test_123',
      });
      expect(result).toEqual({ ...payment, authorizationUrl: 'http://paystack.test/auth' });
    });

    it('charges the attempt currency when the request names none', async () => {
      await service.initiatePayment(userId, { orderId: 'order1', paymentMethod: 'card', currency: undefined });

      expect(mockPaystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GHS' }));
    });

    it.each(['USD', 'NGN', 'ghs'])(
      'rejects %s so the client cannot choose the charge currency, before opening an attempt',
      async (currency) => {
        await expect(
          service.initiatePayment(userId, { orderId: 'order1', paymentMethod: 'card', currency }),
        ).rejects.toThrow(new BadRequestException('currency must be GHS; payments are charged in GHS only'));
        expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
        expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      },
    );

    it('accepts the currency of the store, whichever it is', async () => {
      mockStoreService.getCurrency.mockResolvedValueOnce('USD');

      await expect(
        service.initiatePayment(userId, { orderId: 'order1', paymentMethod: 'card', currency: 'USD' }),
      ).resolves.toBeDefined();
    });

    it('gives each initiation a different reference', async () => {
      await service.initiatePayment(userId, createPaymentDto);
      await service.initiatePayment(userId, createPaymentDto);

      const [first, second] = mockPaymentRepository.openAttempt.mock.calls.map(([request]) => request.reference);
      expect(first).not.toEqual(second);
    });

    it('throws NotFoundException if the order does not exist', async () => {
      mockPaymentRepository.findOrderWithUser.mockResolvedValue(null);

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new NotFoundException('Order "order1" not found'),
      );
      expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if the order does not belong to the user', async () => {
      mockPaymentRepository.findOrderWithUser.mockResolvedValue({ ...order, userId: 'otherUser' });

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new ForbiddenException('Order does not belong to you'),
      );
      expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'CONFIRMED', 'IN_FULFILMENT', 'COMPLETED'])(
      'refuses a %s order before contacting Paystack',
      async (status) => {
        mockPaymentRepository.findOrderWithUser.mockResolvedValue({ ...order, status });

        await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(BadRequestException);
        expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
        expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      },
    );

    it('refuses when the order was cancelled between the first check and the locked re-check', async () => {
      openAttemptAgainst({ ...order, status: 'CANCELLED' }, { created: true, attempt: payment });

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new BadRequestException('Order "order1" is CANCELLED and can no longer be paid'),
      );
      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('refuses an order found already paid when the attempt is opened', async () => {
      openAttemptAgainst(
        { ...order, paymentIntent: { status: 'CAPTURED', attempts: [{ status: PaymentStatus.CAPTURED }] } },
        { created: true, attempt: payment },
      );

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new BadRequestException('Payment for this order has already been completed'),
      );
      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('returns the checkout already opened under a repeated idempotency key without a new Paystack call', async () => {
      openAttemptAgainst(order, { created: false, attempt: payment, authorizationUrl: 'http://paystack.test/first' });

      const result = await service.initiatePayment(userId, { ...createPaymentDto, idempotencyKey: 'key-1' });

      expect(result).toEqual({ ...payment, authorizationUrl: 'http://paystack.test/first' });
      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      expect(paymentRepository.recordCheckout).not.toHaveBeenCalled();
    });

    it('rejects a repeated idempotency key whose attempt is no longer pending', async () => {
      openAttemptAgainst(order, {
        created: false,
        attempt: { ...payment, status: PaymentStatus.CANCELLED },
        authorizationUrl: 'http://paystack.test/first',
      });

      await expect(service.initiatePayment(userId, { ...createPaymentDto, idempotencyKey: 'key-1' })).rejects.toThrow(
        ConflictException,
      );
      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('fails the attempt and frees its key when Paystack cannot open the checkout', async () => {
      const paystackError = new Error('Paystack unavailable');
      mockPaystack.initializeTransaction.mockRejectedValue(paystackError);

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toBe(paystackError);
      expect(paymentRepository.markInitializationFailed).toHaveBeenCalledWith('pay1');
      expect(paymentRepository.recordCheckout).not.toHaveBeenCalled();
    });
  });

  describe('verifyPayment', () => {
    const reference = 'ref1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      amount: new Prisma.Decimal(250),
      currency: 'GHS',
      transactionId: 'ref1',
      status: PaymentStatus.PENDING,
      deleted: false,
    };
    const verification = { status: 'success', reference: 'ref1', amount: 25000, currency: 'GHS' };
    const completed = { ...payment, status: PaymentStatus.CAPTURED };
    const lockedState = {
      status: PaymentStatus.PENDING,
      amount: new Prisma.Decimal(250),
      currency: 'GHS',
      intentStatus: 'PENDING',
      order: { status: 'PLACED', deleted: false },
    };

    /** Runs the service's decision against `state`, as the repository does under the order lock. */
    const settleAgainst = (state: object, attempt: object, refundId?: string) =>
      mockPaymentRepository.settleAttempt.mockImplementation(
        async (_id: string, _verified: unknown, _details: unknown, decide: (s: object) => unknown) => ({
          outcome: decide(state),
          attempt,
          refundId,
        }),
      );

    beforeEach(() => {
      mockPaymentRepository.findByReference.mockResolvedValue(payment);
      mockPaystack.verifyTransaction.mockResolvedValue(verification);
      mockPaymentRepository.findOrderWithUser.mockResolvedValue({ id: 'order1', user: { email: 'buyer@example.com' } });
    });

    it('settles a matching success as payment and returns the completed attempt', async () => {
      settleAgainst(lockedState, completed);

      const result = await service.verifyPayment(reference);

      expect(paymentRepository.findByReference).toHaveBeenCalledWith('ref1');
      expect(mockPaystack.verifyTransaction).toHaveBeenCalledWith('ref1');
      expect(paymentRepository.settleAttempt).toHaveBeenCalledWith(
        'pay1',
        { reference: 'ref1', status: 'success', amount: 25000, currency: 'GHS' },
        expect.objectContaining({ reference: 'ref1', amount: 25000, currency: 'GHS' }),
        expect.any(Function),
      );
      expect(mockLoggerService.warn).not.toHaveBeenCalled();
      expect(result).toEqual(completed);
    });

    it.each([PaymentStatus.CAPTURED, PaymentStatus.FAILED])(
      'returns a %s attempt unchanged without asking Paystack again',
      async (status) => {
        mockPaymentRepository.findByReference.mockResolvedValue({ ...payment, status });

        const result = await service.verifyPayment(reference);

        expect(result).toEqual({ ...payment, status });
        expect(mockPaystack.verifyTransaction).not.toHaveBeenCalled();
        expect(paymentRepository.settleAttempt).not.toHaveBeenCalled();
      },
    );

    it('warns and leaves the order alone when a success arrives for an order that is no longer PLACED', async () => {
      settleAgainst({ ...lockedState, order: { status: 'CANCELLED', deleted: false } }, completed, 'refund1');

      const result = await service.verifyPayment(reference);
      await flushPromises();

      expect(result).toEqual(completed);
      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        expect.stringMatching(/ORDER_NOT_PAYABLE.*order1.*pay1.*refund1/),
        'PaymentService',
      );
    });

    it('does not count a success for a smaller amount as payment', async () => {
      mockPaystack.verifyTransaction.mockResolvedValue({ ...verification, amount: 100 });
      settleAgainst(lockedState, { ...payment, status: PaymentStatus.FAILED }, 'refund1');

      const result = await service.verifyPayment(reference);
      await flushPromises();

      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(mockLoggerService.warn).toHaveBeenCalledWith(expect.stringContaining('AMOUNT_MISMATCH'), 'PaymentService');
    });

    it('should handle failed payment', async () => {
      const failedPayment = { ...payment, status: PaymentStatus.FAILED };
      mockPaystack.verifyTransaction.mockResolvedValue({ status: 'failed', reference: 'ref1' });
      settleAgainst(lockedState, failedPayment);

      const result = await service.verifyPayment(reference);

      expect(paymentRepository.settleAttempt).toHaveBeenCalledWith(
        'pay1',
        expect.objectContaining({ status: 'failed' }),
        expect.any(Object),
        expect.any(Function),
      );
      expect(result).toEqual(failedPayment);
    });

    it('rejects a Paystack answer for a different reference without touching the attempt', async () => {
      mockPaystack.verifyTransaction.mockResolvedValue({ ...verification, reference: 'other' });

      await expect(service.verifyPayment(reference)).rejects.toThrow(BadGatewayException);
      expect(paymentRepository.settleAttempt).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPaymentRepository.findByReference.mockResolvedValue(null);

      await expect(service.verifyPayment(reference)).rejects.toThrow(
        new NotFoundException('Payment with reference "ref1" not found'),
      );
    });

    it('applies the same rule when the owner verifies', async () => {
      mockPaymentRepository.findOrderById.mockResolvedValue({ id: 'order1', userId: 'user1' });
      mockPaystack.verifyTransaction.mockResolvedValue({ ...verification, currency: 'USD' });
      settleAgainst(lockedState, { ...payment, status: PaymentStatus.FAILED }, 'refund1');

      const result = await service.verifyPaymentAsUser(reference, 'user1');

      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        expect.stringContaining('CURRENCY_MISMATCH'),
        'PaymentService',
      );
    });

    it('refuses a reference that belongs to another user', async () => {
      mockPaymentRepository.findOrderById.mockResolvedValue({ id: 'order1', userId: 'someone-else' });

      await expect(service.verifyPaymentAsUser(reference, 'user1')).rejects.toThrow(ForbiddenException);
      expect(mockPaystack.verifyTransaction).not.toHaveBeenCalled();
    });
  });

  describe('getPayment', () => {
    const paymentId = 'pay1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      status: PaymentStatus.PENDING,
      deleted: false,
      order: { id: 'order1', userId: 'user1' },
    };

    it('should retrieve payment for owner user', async () => {
      mockPaymentRepository.findById.mockResolvedValue(payment);
      mockPaymentRepository.findOrderById.mockResolvedValue({ id: 'order1', userId: 'user1' });

      const result = await service.getPayment(paymentId, 'user1', false);

      expect(paymentRepository.findById).toHaveBeenCalledWith(paymentId);
      expect(result).toEqual(payment);
    });

    it('should allow admin to retrieve any payment', async () => {
      mockPaymentRepository.findById.mockResolvedValue(payment);

      const result = await service.getPayment(paymentId, 'admin1', true);

      expect(result).toEqual(payment);
      expect(paymentRepository.findOrderById).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException if user tries to access another user's payment", async () => {
      mockPaymentRepository.findById.mockResolvedValue(payment);
      mockPaymentRepository.findOrderById.mockResolvedValue({ id: 'order1', userId: 'other-user' });

      await expect(service.getPayment(paymentId, 'user1', false)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPaymentRepository.findById.mockResolvedValue(null);

      await expect(service.getPayment(paymentId, 'user1', false)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getUserPayments', () => {
    const userId = 'user1';
    const payments = [
      { id: 'pay1', orderId: 'order1', status: PaymentStatus.PENDING, deleted: false, order: { id: 'order1' } },
    ];

    it('should retrieve user payments successfully', async () => {
      mockPaymentRepository.findByUser.mockResolvedValue(payments);

      const result = await service.getUserPayments(userId);

      expect(paymentRepository.findByUser).toHaveBeenCalledWith(userId);
      expect(result).toEqual(payments);
    });

    it('should return empty array if no payments found', async () => {
      mockPaymentRepository.findByUser.mockResolvedValue([]);

      const result = await service.getUserPayments(userId);

      expect(result).toEqual([]);
    });
  });

  describe('softDelete', () => {
    const paymentId = 'pay1';
    const payment = { id: 'pay1', orderId: 'order1', status: PaymentStatus.PENDING, deleted: false };
    const updatedPayment = { ...payment, deleted: true, deletedAt: new Date() };

    it('should soft delete payment successfully', async () => {
      mockPaymentRepository.findById.mockResolvedValue(payment);
      mockPaymentRepository.update.mockResolvedValue(updatedPayment);

      const result = await service.softDelete(paymentId);

      expect(paymentRepository.findById).toHaveBeenCalledWith(paymentId);
      expect(paymentRepository.update).toHaveBeenCalledWith(paymentId, { deleted: true, deletedAt: expect.any(Date) });
      expect(result).toEqual(updatedPayment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPaymentRepository.findById.mockResolvedValue(null);

      await expect(service.softDelete(paymentId)).rejects.toThrow(new NotFoundException('Payment Not found'));
    });
  });

  describe('restore', () => {
    const paymentId = 'pay1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      status: PaymentStatus.PENDING,
      deleted: true,
      deletedAt: new Date(),
    };
    const restoredPayment = { ...payment, deleted: false, deletedAt: null };

    it('should restore payment successfully', async () => {
      mockPaymentRepository.findById.mockResolvedValue(payment);
      mockPaymentRepository.update.mockResolvedValue(restoredPayment);

      const result = await service.restore(paymentId);

      expect(paymentRepository.findById).toHaveBeenCalledWith(paymentId);
      expect(paymentRepository.update).toHaveBeenCalledWith(paymentId, { deleted: false, deletedAt: null });
      expect(result).toEqual(restoredPayment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPaymentRepository.findById.mockResolvedValue(null);

      await expect(service.restore(paymentId)).rejects.toThrow(new NotFoundException('Payment Not found'));
    });
  });

  describe('recordCodPayment', () => {
    const tx = { tx: true };
    const attempt = { id: 'pay1', orderId: 'order1', status: PaymentStatus.CAPTURED };
    const recorded = {
      attempt,
      collection: { id: 'cc1', amount: new Prisma.Decimal(250), currency: 'GHS' },
      from: 'IN_FULFILMENT',
    };
    const shippedCod = {
      status: 'IN_FULFILMENT',
      deleted: false,
      paymentMethod: 'CASH_ON_DELIVERY',
      paymentIntent: null,
      shipments: [{ id: 'ship1', status: 'OUT_FOR_DELIVERY' }],
    };

    const runRecording = (order: unknown) =>
      mockPaymentRepository.recordCashCollection.mockImplementation(
        async (_orderId, _adminId, assertCollectable, onRecorded) => {
          assertCollectable(order);
          await onRecorded(tx, recorded);
          return recorded;
        },
      );

    it('records the collection for the order and returns the completed payment', async () => {
      runRecording(shippedCod);

      const result = await service.recordCodPayment('order1', 'admin1');

      expect(paymentRepository.recordCashCollection).toHaveBeenCalledWith(
        'order1',
        'admin1',
        expect.any(Function),
        expect.any(Function),
      );
      expect(result).toEqual(attempt);
    });

    it('writes the audit row on the recording transaction with the actor, amount and status change', async () => {
      runRecording(shippedCod);

      await service.recordCodPayment('order1', 'admin1');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'Order',
          entityId: 'order1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: {
            from: 'IN_FULFILMENT',
            to: 'COMPLETED',
            cashCollectionId: 'cc1',
            paymentId: 'pay1',
            amount: '250.00',
            currency: 'GHS',
          },
        },
        tx,
      );
    });

    it.each(['PLACED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'])(
      'refuses an order in %s under the lock and audits nothing',
      async (status) => {
        runRecording({ ...shippedCod, status });

        await expect(service.recordCodPayment('order1', 'admin1')).rejects.toThrow(ConflictException);
        expect(mockAuditService.log).not.toHaveBeenCalled();
      },
    );

    it('refuses an online order', async () => {
      runRecording({ ...shippedCod, paymentMethod: 'ONLINE' });

      await expect(service.recordCodPayment('order1', 'admin1')).rejects.toThrow(BadRequestException);
    });

    it('refuses a second collection for an order whose payment is already recorded', async () => {
      runRecording({ ...shippedCod, paymentIntent: { status: 'CAPTURED', attempts: [{ status: 'CAPTURED' }] } });

      await expect(service.recordCodPayment('order1', 'admin1')).rejects.toThrow(
        new ConflictException('Payment for order "order1" has already been recorded'),
      );
    });

    it('treats a missing order as not found', async () => {
      runRecording(null);

      await expect(service.recordCodPayment('order1', 'admin1')).rejects.toThrow(NotFoundException);
    });
  });
});
