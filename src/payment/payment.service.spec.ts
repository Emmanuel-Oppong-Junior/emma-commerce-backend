import { Test, TestingModule } from '@nestjs/testing';
import { PaymentService } from './payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaystackWebhookDto } from './dto/paystack.dto';
import { PaystackEvent } from './enums/paystack-event.enum';
import { createHmac } from 'crypto';
import { PaymentStatus } from '@prisma/client';
import { LoggerService } from '../commons/logger.service';
import { Role } from '../users/enums/role.enum';

// Stable mock instance shared between service constructor and test references
const mockPaystackTransaction = {
  initialize: jest.fn(),
  verify: jest.fn(),
};

jest.mock('paystack-api', () => jest.fn(() => ({ transaction: mockPaystackTransaction })));

const mockPrismaService = {
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockConfigService = {
  get: jest.fn(),
};

const mockLoggerService = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

describe('PaymentService', () => {
  let service: PaymentService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
    prisma = module.get<PrismaService>(PrismaService);

    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'PAYSTACK_SECRET_KEY') return 'test_secret';
      if (key === 'PAYSTACK_CALLBACK_URL') return 'http://callback.test';
      return undefined;
    });

    jest.clearAllMocks();
  });

  describe('initiatePayment', () => {
    const userId = 'user1';
    const createPaymentDto: CreatePaymentDto = {
      orderId: 'order1',
      currency: 'NGN',
      paymentMethod: 'card',
    };
    const order = {
      id: 'order1',
      userId: 'user1',
      totalAmount: 1000,
      user: { email: 'test@example.com' },
    };
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      amount: 1000,
      currency: 'NGN',
      paymentMethod: 'card',
      status: PaymentStatus.PENDING,
      transactionId: 'order1-1234567890',
      paymentDetails: {},
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const transaction = {
      data: {
        reference: 'order1-1234567890',
        authorization_url: 'http://paystack.test/auth',
        access_code: 'acc_test_123',
      },
    };

    it('should initiate payment successfully', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(order);
      mockPrismaService.payment.findUnique.mockResolvedValue(null);
      mockPaystackTransaction.initialize.mockResolvedValue(transaction);
      mockPrismaService.payment.create.mockResolvedValue(payment);

      const result = await service.initiatePayment(userId, createPaymentDto);

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: 'order1' },
        include: { user: true },
      });
      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { orderId: 'order1' },
      });
      expect(mockPaystackTransaction.initialize).toHaveBeenCalledWith({
        email: 'test@example.com',
        amount: 100000, // 1000 * 100
        currency: 'NGN',
        reference: expect.any(String),
        callback_url: 'http://callback.test',
      });
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order1',
          amount: 1000,
          currency: 'NGN',
          paymentMethod: 'card',
          status: PaymentStatus.PENDING,
          transactionId: 'order1-1234567890',
          paymentDetails: {
            reference: transaction.data.reference,
            access_code: transaction.data.access_code,
          },
        },
      });
      expect(result).toEqual({
        ...payment,
        authorizationUrl: 'http://paystack.test/auth',
      });
    });

    it('should throw NotFoundException if order not found', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new NotFoundException('Order "order1" not found'),
      );
    });

    it('should throw ForbiddenException if order does not belong to user', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({
        ...order,
        userId: 'otherUser',
      });

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new ForbiddenException('Order does not belong to you'),
      );
    });

    it('should throw BadRequestException if payment already initiated', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(order);
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);

      await expect(service.initiatePayment(userId, createPaymentDto)).rejects.toThrow(
        new BadRequestException('Payment already initiated for this order'),
      );
    });
  });

  describe('verifyPayment', () => {
    const reference = 'ref1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      transactionId: 'ref1',
      status: PaymentStatus.PENDING,
      deleted: false,
    };
    const verification = {
      data: { status: 'success', reference: 'ref1' },
    };
    const updatedPayment = {
      ...payment,
      status: PaymentStatus.COMPLETED,
      paymentDetails: verification.data,
    };

    it('should verify payment successfully', async () => {
      mockPrismaService.payment.findFirst.mockResolvedValue(payment);
      mockPaystackTransaction.verify.mockResolvedValue(verification);
      mockPrismaService.payment.update.mockResolvedValue(updatedPayment);

      const result = await service.verifyPayment(reference);

      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: { transactionId: 'ref1', deleted: false },
      });
      expect(mockPaystackTransaction.verify).toHaveBeenCalledWith({
        reference: 'ref1',
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: {
          status: PaymentStatus.COMPLETED,
          paymentDetails: verification.data,
        },
      });
      expect(result).toEqual(updatedPayment);
    });

    it('should handle failed payment', async () => {
      const failedVerification = {
        data: { status: 'failed', reference: 'ref1' },
      };
      const failedPayment = {
        ...payment,
        status: PaymentStatus.FAILED,
        paymentDetails: failedVerification.data,
      };

      mockPrismaService.payment.findFirst.mockResolvedValue(payment);
      mockPaystackTransaction.verify.mockResolvedValue(failedVerification);
      mockPrismaService.payment.update.mockResolvedValue(failedPayment);

      const result = await service.verifyPayment(reference);

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: {
          status: PaymentStatus.FAILED,
          paymentDetails: failedVerification.data,
        },
      });
      expect(result).toEqual(failedPayment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findFirst.mockResolvedValue(null);

      await expect(service.verifyPayment(reference)).rejects.toThrow(
        new NotFoundException('Payment with reference "ref1" not found'),
      );
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
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockPrismaService.order.findUnique.mockResolvedValue({ id: 'order1', userId: 'user1' });

      const result = await service.getPayment(paymentId, 'user1', Role.USER);

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay1', deleted: false },
        include: { order: true },
      });
      expect(result).toEqual(payment);
    });

    it('should allow admin to retrieve any payment', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);

      const result = await service.getPayment(paymentId, 'admin1', Role.ADMIN);
      expect(result).toEqual(payment);
      // Admin does not need to check order ownership
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException if user tries to access another user's payment", async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockPrismaService.order.findUnique.mockResolvedValue({ id: 'order1', userId: 'other-user' });

      await expect(service.getPayment(paymentId, 'user1', Role.USER)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);
      await expect(service.getPayment(paymentId, 'user1', Role.USER)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getUserPayments', () => {
    const userId = 'user1';
    const payments = [
      {
        id: 'pay1',
        orderId: 'order1',
        status: PaymentStatus.PENDING,
        deleted: false,
        order: { id: 'order1' },
      },
    ];

    it('should retrieve user payments successfully', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue(payments);

      const result = await service.getUserPayments(userId);

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { order: { userId: 'user1' }, deleted: false },
        include: { order: true },
      });
      expect(result).toEqual(payments);
    });

    it('should return empty array if no payments found', async () => {
      mockPrismaService.payment.findMany.mockResolvedValue([]);

      const result = await service.getUserPayments(userId);

      expect(result).toEqual([]);
    });
  });

  describe('handlePaystackWebhook', () => {
    const webhookDto: PaystackWebhookDto = {
      event: PaystackEvent.CHARGE_SUCCESS,
      data: { reference: 'ref1', status: 'success' },
    } as PaystackWebhookDto;
    beforeEach(() => {
      const secret = 'test_secret';
      const hash = createHmac('sha512', secret).update(JSON.stringify(webhookDto)).digest('hex');
      mockConfigService.get.mockReturnValue(secret);
      jest.spyOn(service as any, 'computeWebhookSignature').mockReturnValue(hash);
    });

    it('should return false for invalid signature', async () => {
      jest.spyOn(service as any, 'isValidWebhookSignature').mockReturnValue(false);

      const result = await service.handlePaystackWebhook(webhookDto, 'invalid_signature');

      expect(result).toBe(false);
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('should return false for irrelevant event', async () => {
      jest.spyOn(service as any, 'isValidWebhookSignature').mockReturnValue(true);
      jest.spyOn(service as any, 'isRelevantEvent').mockReturnValue(false);

      const result = await service.handlePaystackWebhook(
        { ...webhookDto, event: 'transfer.success' as PaystackEvent },
        'valid_signature',
      );

      expect(result).toBe(false);
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('should return false if payment not found', async () => {
      jest.spyOn(service as any, 'isValidWebhookSignature').mockReturnValue(true);
      jest.spyOn(service as any, 'isRelevantEvent').mockReturnValue(true);
      mockPrismaService.payment.findFirst.mockResolvedValue(null);

      const result = await service.handlePaystackWebhook(webhookDto, 'valid_signature');

      expect(result).toBe(false);
    });
  });

  describe('handlePaystackWebhook — signature validation', () => {
    it('should reject webhook with invalid HMAC signature', async () => {
      const dto: PaystackWebhookDto = {
        event: PaystackEvent.CHARGE_SUCCESS,
        data: { reference: 'ref-sig-test', status: 'success' },
      } as PaystackWebhookDto;
      mockConfigService.get.mockReturnValue('real-secret');

      const result = await service.handlePaystackWebhook(dto, 'invalid-sig');
      expect(result).toBe(false);
    });

    it('should accept webhook with valid HMAC signature', async () => {
      const dto: PaystackWebhookDto = {
        event: PaystackEvent.CHARGE_SUCCESS,
        data: { reference: 'ref-valid', status: 'success' },
      } as PaystackWebhookDto;
      const secret = 'real-secret';
      mockConfigService.get.mockReturnValue(secret);
      const validSig = createHmac('sha512', secret).update(JSON.stringify(dto)).digest('hex');

      const payment = { id: 'pay1', transactionId: 'ref-valid', deleted: false };
      const verifyData = { data: { status: 'success', reference: 'ref-valid' } };
      mockPrismaService.payment.findFirst.mockResolvedValue(payment);
      mockPaystackTransaction.verify.mockResolvedValue(verifyData);
      mockPrismaService.payment.update.mockResolvedValue({ ...payment, status: PaymentStatus.COMPLETED });
      mockPrismaService.order.update.mockResolvedValue({});

      const result = await service.handlePaystackWebhook(dto, validSig);
      expect(result).toBe(true);
    });

    it('should log error via LoggerService (not console) on webhook failure', async () => {
      const dto: PaystackWebhookDto = {
        event: PaystackEvent.CHARGE_SUCCESS,
        data: { reference: 'ref-fail', status: 'success' },
      } as PaystackWebhookDto;
      const secret = 'real-secret';
      mockConfigService.get.mockReturnValue(secret);
      const validSig = createHmac('sha512', secret).update(JSON.stringify(dto)).digest('hex');

      mockPrismaService.payment.findFirst.mockRejectedValue(new Error('DB down'));

      const result = await service.handlePaystackWebhook(dto, validSig);
      expect(result).toBe(false);
      expect(mockLoggerService.error).toHaveBeenCalledWith(
        expect.stringContaining('Webhook processing failed'),
        expect.any(String),
        'PaymentService',
      );
    });
  });

  describe('softDelete', () => {
    const paymentId = 'pay1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      status: PaymentStatus.PENDING,
      deleted: false,
    };
    const updatedPayment = { ...payment, deleted: true, deletedAt: new Date() };

    it('should soft delete payment successfully', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockPrismaService.payment.update.mockResolvedValue(updatedPayment);

      const result = await service.softDelete(paymentId);

      expect(prisma.payment.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: { deleted: true, deletedAt: expect.any(Date) },
      });
      expect(result).toEqual(updatedPayment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);
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
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockPrismaService.payment.update.mockResolvedValue(restoredPayment);

      const result = await service.restore(paymentId);

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: 'pay1' },
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay1' },
        data: { deleted: false, deletedAt: null },
      });
      expect(result).toEqual(restoredPayment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      await expect(service.restore(paymentId)).rejects.toThrow(new NotFoundException('Payment Not found'));
    });
  });

  describe('remove', () => {
    const paymentId = 'pay1';
    const payment = {
      id: 'pay1',
      orderId: 'order1',
      status: PaymentStatus.PENDING,
      deleted: false,
    };

    it('should remove payment successfully', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(payment);
      mockPrismaService.payment.delete.mockResolvedValue(payment);

      const result = await service.remove(paymentId);

      expect(prisma.payment.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.payment.delete).toHaveBeenCalledWith({
        where: { id: 'pay1' },
      });
      expect(result).toEqual(payment);
    });

    it('should throw NotFoundException if payment not found', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);

      await expect(service.remove(paymentId)).rejects.toThrow(new NotFoundException('Payment Not found'));
    });
  });
});
