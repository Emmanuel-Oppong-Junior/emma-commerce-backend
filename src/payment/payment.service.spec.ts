import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
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
import { StoreService } from '../store/store.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { paymentSettingsStub, providerRegistryWith } from '../../test/helpers/payment-providers.helper';
import { OnlinePaymentMethod } from './settings/payment-methods';
import { PaymentSettingsService } from './settings/payment-settings.service';
import { VelocityService } from '../fraud/velocity.service';
import { velocityStub } from '../../test/helpers/velocity.helper';

const mockPaystack = {
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
};

const mockPaymentRepository = {
  openAttempt: jest.fn(),
  recordCheckout: jest.fn(),
  markInitializationFailed: jest.fn(),
  findById: jest.fn(),
  restoreDeleted: jest.fn(),
  findByReference: jest.fn(),
  findByOrderId: jest.fn(),
  findByUser: jest.fn(),
  update: jest.fn(),
  recordCashCollection: jest.fn(),
  findOrderWithUser: jest.fn(),
  findOrderById: jest.fn(),
  settleAttempt: jest.fn(),
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

const mockPaymentSettings = paymentSettingsStub({ callbackUrl: 'http://callback.test' });

const mockVelocity = velocityStub();

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('PaymentService', () => {
  let service: PaymentService;
  let paymentRepository: jest.Mocked<PaymentRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PaymentRepository, useValue: mockPaymentRepository },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: AuditService, useValue: mockAuditService },
        {
          provide: PaymentProviderRegistry,
          useValue: providerRegistryWith(mockPaystack, mockPaymentSettings),
        },
        { provide: PaymentSettingsService, useValue: mockPaymentSettings },
        { provide: StoreService, useValue: mockStoreService },
        { provide: VelocityService, useValue: mockVelocity },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    paymentRepository = module.get<PaymentRepository>(PaymentRepository) as jest.Mocked<PaymentRepository>;

    jest.clearAllMocks();
  });

  describe('initiatePayment', () => {
    const userId = 'user1';
    const createPaymentDto: CreatePaymentDto = {
      orderId: 'order1',
      currency: 'GHS',
      paymentMethod: OnlinePaymentMethod.CARD,
    };
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
        expect.objectContaining({ orderId: 'order1', idempotencyKey: 'key-1', provider: 'PAYSTACK', channel: 'CARD' }),
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
      await service.initiatePayment(userId, {
        orderId: 'order1',
        paymentMethod: OnlinePaymentMethod.CARD,
        currency: undefined,
      });

      expect(mockPaystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GHS' }));
    });

    it.each(['USD', 'NGN', 'ghs'])(
      'rejects %s so the client cannot choose the charge currency, before opening an attempt',
      async (currency) => {
        await expect(
          service.initiatePayment(userId, { orderId: 'order1', paymentMethod: OnlinePaymentMethod.CARD, currency }),
        ).rejects.toThrow(new BadRequestException('currency must be GHS; payments are charged in GHS only'));
        expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
        expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      },
    );

    it('accepts the currency of the store, whichever it is', async () => {
      mockStoreService.getCurrency.mockResolvedValueOnce('USD');

      await expect(
        service.initiatePayment(userId, {
          orderId: 'order1',
          paymentMethod: OnlinePaymentMethod.CARD,
          currency: 'USD',
        }),
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

    describe('velocity checks', () => {
      const softHit = { rule: 'PAYMENT_ATTEMPTS_PER_IP_1H', level: 'SOFT', count: 21, limit: 20 };

      it('screens the customer and IP, then flags soft hits on the order and counts the new attempt', async () => {
        mockVelocity.screenOrRefuse.mockResolvedValueOnce([softHit]);

        await service.initiatePayment(userId, createPaymentDto, '::ffff:41.66.1.2');

        const subjects = { CUSTOMER: 'user1', IP: '41.66.1.2' };
        expect(mockVelocity.screenOrRefuse).toHaveBeenCalledWith('PAYMENT_INITIATION', subjects);
        expect(mockVelocity.flagOrder).toHaveBeenCalledWith('order1', [softHit]);
        expect(mockVelocity.record).toHaveBeenCalledWith('PAYMENT_STARTED', subjects);
      });

      it('opens no attempt when a hard limit refuses it', async () => {
        mockVelocity.screenOrRefuse.mockRejectedValueOnce(new ForbiddenException('Too many payment attempts'));

        await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(ForbiddenException);
        expect(paymentRepository.openAttempt).not.toHaveBeenCalled();
        expect(mockVelocity.record).not.toHaveBeenCalled();
      });

      it('does not count a replay of an idempotency key as a new attempt', async () => {
        openAttemptAgainst(order, { created: false, attempt: payment, authorizationUrl: 'http://paystack.test/auth' });

        await service.initiatePayment(userId, { ...createPaymentDto, idempotencyKey: 'key-1' });

        expect(mockVelocity.record).not.toHaveBeenCalled();
        expect(mockVelocity.flagOrder).not.toHaveBeenCalled();
      });
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
      provider: 'PAYSTACK',
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

    describe('velocity checks', () => {
      const failedState = { ...lockedState };
      const cardHit = { rule: 'FAILED_PAYMENTS_PER_CARD_24H', level: 'HARD', count: 7, limit: 6 };

      it('counts a failure against the customer and the card, then flags the order when they are above a limit', async () => {
        mockPaystack.verifyTransaction.mockResolvedValue({
          reference: 'ref1',
          status: 'failed',
          authorization: { signature: 'SIG_card', last4: '4081' },
        });
        settleAgainst(failedState, { ...payment, status: PaymentStatus.FAILED, order: { userId: 'user1' } });
        mockVelocity.screen.mockResolvedValueOnce([cardHit]);

        await service.verifyPayment(reference);

        const subjects = { CUSTOMER: 'user1', CARD: 'SIG_card' };
        expect(mockVelocity.record).toHaveBeenCalledWith('PAYMENT_FAILED', subjects);
        expect(mockVelocity.screen).toHaveBeenCalledWith('PAYMENT_SETTLEMENT', subjects);
        expect(mockVelocity.flagOrder).toHaveBeenCalledWith('order1', [cardHit]);
      });

      it('checks the card of a success without counting a failure', async () => {
        mockPaystack.verifyTransaction.mockResolvedValue({ ...verification, authorization: { signature: 'SIG_card' } });
        settleAgainst(lockedState, { ...completed, order: { userId: 'user1' } });

        await service.verifyPayment(reference);

        expect(mockVelocity.record).not.toHaveBeenCalled();
        expect(mockVelocity.screen).toHaveBeenCalledWith('PAYMENT_SETTLEMENT', { CUSTOMER: 'user1', CARD: 'SIG_card' });
      });

      it('checks nothing for a mobile money success (no card)', async () => {
        settleAgainst(lockedState, completed);

        await service.verifyPayment(reference);

        expect(mockVelocity.screen).not.toHaveBeenCalled();
      });
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

    it('restores a soft-deleted payment without first looking it up among the visible ones', async () => {
      mockPaymentRepository.restoreDeleted.mockResolvedValue(restoredPayment);

      const result = await service.restore(paymentId);

      expect(paymentRepository.restoreDeleted).toHaveBeenCalledWith(paymentId);
      expect(paymentRepository.findById).not.toHaveBeenCalled();
      expect(result).toEqual(restoredPayment);
    });

    it('answers NOT_FOUND when no soft-deleted payment has the id (unknown or not deleted)', async () => {
      mockPaymentRepository.restoreDeleted.mockResolvedValue(null);

      await expect(service.restore(paymentId)).rejects.toThrow(new NotFoundException('Payment Not found'));
    });
  });

  describe('recordCodPayment', () => {
    const tx = { tx: true };
    const attempt = { id: 'pay1', orderId: 'order1', status: PaymentStatus.CAPTURED };
    const collectedAt = new Date('2026-11-22T10:00:00Z');
    const recorded = {
      attempt,
      collection: { id: 'cc1', amount: new Prisma.Decimal(250), currency: 'GHS', collectedAt },
      from: 'IN_FULFILMENT',
    };
    const shippedCod = {
      status: 'IN_FULFILMENT',
      deleted: false,
      paymentMethod: 'CASH_ON_DELIVERY',
      grandTotal: new Prisma.Decimal('250.00'),
      paymentIntent: null,
      shipments: [{ id: 'ship1', status: 'OUT_FOR_DELIVERY', dispatchedAt: new Date('2026-11-22T08:00:00Z') }],
    };
    const staffRider = { isActive: true, isStaff: true };
    const input = { orderId: 'order1', riderId: 'rider1', amount: new Prisma.Decimal('250'), collectedAt };

    const runRecording = (order: unknown, rider: unknown = staffRider) =>
      mockPaymentRepository.recordCashCollection.mockImplementation(
        async (_orderId, _request, assertCollectable, onRecorded) => {
          assertCollectable(order, rider);
          await onRecorded(tx, recorded);
          return recorded;
        },
      );

    const reasonOf = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => null,
        (caught: BadRequestException) => caught,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      return (error?.getResponse() as { extensions?: { reason?: string } }).extensions?.reason;
    };

    it('records the collection for the order with the rider and time, and returns the completed payment', async () => {
      runRecording(shippedCod);

      const result = await service.recordCodPayment(input, 'admin1');

      expect(paymentRepository.recordCashCollection).toHaveBeenCalledWith(
        'order1',
        { recordedById: 'admin1', riderId: 'rider1', collectedAt },
        expect.any(Function),
        expect.any(Function),
      );
      expect(result).toEqual(attempt);
    });

    it('collects at the time of recording when no collectedAt is sent', async () => {
      runRecording(shippedCod);
      const before = Date.now();

      await service.recordCodPayment({ ...input, collectedAt: undefined }, 'admin1');

      const [, request] = mockPaymentRepository.recordCashCollection.mock.calls[0];
      expect(request.collectedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(request.collectedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('writes the audit row on the recording transaction with the actor, rider, amount and status change', async () => {
      runRecording(shippedCod);

      await service.recordCodPayment(input, 'admin1');

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
            riderId: 'rider1',
            collectedAt: '2026-11-22T10:00:00.000Z',
          },
        },
        tx,
      );
    });

    it.each(['PLACED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'])(
      'refuses an order in %s under the lock and audits nothing',
      async (status) => {
        runRecording({ ...shippedCod, status });

        await expect(service.recordCodPayment(input, 'admin1')).rejects.toThrow(ConflictException);
        expect(mockAuditService.log).not.toHaveBeenCalled();
      },
    );

    it('refuses an online order', async () => {
      runRecording({ ...shippedCod, paymentMethod: 'ONLINE' });

      await expect(service.recordCodPayment(input, 'admin1')).rejects.toThrow(BadRequestException);
    });

    it('refuses a second collection for an order whose payment is already recorded', async () => {
      runRecording({ ...shippedCod, paymentIntent: { status: 'CAPTURED', attempts: [{ status: 'CAPTURED' }] } });

      await expect(service.recordCodPayment(input, 'admin1')).rejects.toThrow(
        new ConflictException('Payment for order "order1" has already been recorded'),
      );
    });

    it('treats a missing order as not found', async () => {
      runRecording(null);

      await expect(service.recordCodPayment(input, 'admin1')).rejects.toThrow(NotFoundException);
    });

    it.each([
      ['unknown', null],
      ['without a store role', { isActive: true, isStaff: false }],
      ['archived', { isActive: false, isStaff: true }],
    ])('refuses a rider who is %s (RIDER_NOT_STAFF) and audits nothing', async (_case, rider) => {
      runRecording(shippedCod, rider);

      expect(await reasonOf(service.recordCodPayment(input, 'admin1'))).toBe('RIDER_NOT_STAFF');
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('refuses a shipment with a rider (PROOF_OF_DELIVERY_REQUIRED), which completeDelivery records with its proof', async () => {
      const withRider = { ...shippedCod, shipments: [{ ...shippedCod.shipments[0], riderId: 'rider1' }] };
      runRecording(withRider, { isActive: true, isStaff: true, isRider: true });

      expect(await reasonOf(service.recordCodPayment(input, 'admin1'))).toBe('PROOF_OF_DELIVERY_REQUIRED');

      mockPaymentRepository.recordCashCollection.mockImplementation(
        async (_orderId, _request, assertCollectable, onRecorded, outerTx) => {
          assertCollectable(withRider, { isActive: true, isStaff: true, isRider: true });
          await onRecorded(outerTx, recorded);
          return recorded;
        },
      );
      const proofTx = { proof: true };
      await expect(
        service.recordDeliveredCash(proofTx as never, { ...input, riderId: 'rider1' }, 'rider1'),
      ).resolves.toBe('cc1');
      expect(paymentRepository.recordCashCollection).toHaveBeenLastCalledWith(
        'order1',
        { recordedById: 'rider1', riderId: 'rider1', collectedAt },
        expect.any(Function),
        expect.any(Function),
        proofTx,
      );
    });

    it('needs a rider (a role with delivery.ride) for a delivery, and any staff member at the pickup counter', async () => {
      const delivery = { ...shippedCod, fulfillmentType: 'DELIVERY' };
      runRecording(delivery, { isActive: true, isStaff: true, isRider: false });
      expect(await reasonOf(service.recordCodPayment(input, 'admin1'))).toBe('NOT_A_RIDER');
      expect(mockAuditService.log).not.toHaveBeenCalled();

      runRecording(delivery, { isActive: true, isStaff: true, isRider: true });
      await expect(service.recordCodPayment(input, 'admin1')).resolves.toEqual(attempt);

      runRecording(
        {
          ...shippedCod,
          fulfillmentType: 'PICKUP',
          shipments: [{ ...shippedCod.shipments[0], status: 'READY_FOR_PICKUP' }],
        },
        { isActive: true, isStaff: true, isRider: false },
      );
      await expect(service.recordCodPayment(input, 'admin1')).resolves.toEqual(attempt);
    });

    it.each(['249.99', '250.01', '0'])(
      'refuses %s collected for a 250.00 order (COLLECTION_AMOUNT_MISMATCH)',
      async (amount) => {
        runRecording(shippedCod);

        expect(
          await reasonOf(service.recordCodPayment({ ...input, amount: new Prisma.Decimal(amount) }, 'admin1')),
        ).toBe('COLLECTION_AMOUNT_MISMATCH');
      },
    );

    it('refuses a collection time before dispatch or in the future (INVALID_COLLECTION_TIME)', async () => {
      runRecording(shippedCod);
      const beforeDispatch = new Date('2026-11-22T07:59:59Z');
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      expect(await reasonOf(service.recordCodPayment({ ...input, collectedAt: beforeDispatch }, 'admin1'))).toBe(
        'INVALID_COLLECTION_TIME',
      );
      expect(await reasonOf(service.recordCodPayment({ ...input, collectedAt: tomorrow }, 'admin1'))).toBe(
        'INVALID_COLLECTION_TIME',
      );
    });
  });
});
