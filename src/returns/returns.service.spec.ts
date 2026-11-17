import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsRepository } from './returns.repository';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../commons/logger.service';
import { ReturnRequest } from '@prisma/client';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockReturnsRepository = {
  create: jest.fn(),
  findById: jest.fn(),
  findByOrder: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  updateStatus: jest.fn(),
};

const mockPrisma = {
  order: { findUnique: jest.fn() },
  paymentAttempt: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const mockConfigService = { get: jest.fn().mockReturnValue('paystack_secret') };
const mockLogger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockReturnRequest = {
  id: 'return1',
  orderId: 'order1',
  userId: 'user1',
  reason: 'Defective item',
  status: 'PENDING',
  refundAmount: null,
  adminNote: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
} as unknown as ReturnRequest;

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'DELIVERED',
};

describe('ReturnsService', () => {
  let service: ReturnsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: ReturnsRepository, useValue: mockReturnsRepository },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ReturnsService>(ReturnsService);
    jest.clearAllMocks();
  });

  describe('createReturnRequest', () => {
    it('should create a return request for a delivered order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockReturnsRepository.findByOrder.mockResolvedValue([]);
      mockReturnsRepository.create.mockResolvedValue(mockReturnRequest);

      const result = await service.createReturnRequest('user1', {
        orderId: 'order1',
        reason: 'Defective item',
      });

      expect(result).toEqual(mockReturnRequest);
      expect(mockReturnsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order1', userId: 'user1', reason: 'Defective item' }),
      );
    });

    it('should throw NotFoundException if order not found or not owned by user', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(service.createReturnRequest('user1', { orderId: 'nonexistent', reason: 'reason' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if order belongs to a different user', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, userId: 'other-user' });

      await expect(service.createReturnRequest('user1', { orderId: 'order1', reason: 'reason' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if order is not delivered', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({ ...mockOrder, status: 'PENDING' });

      await expect(service.createReturnRequest('user1', { orderId: 'order1', reason: 'reason' })).rejects.toThrow(
        'Return requests can only be made for delivered orders',
      );
    });

    it('should throw BadRequestException if an active return request already exists', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockReturnsRepository.findByOrder.mockResolvedValue([{ ...mockReturnRequest, status: 'PENDING' }]);

      await expect(service.createReturnRequest('user1', { orderId: 'order1', reason: 'reason' })).rejects.toThrow(
        'A return request for this order already exists',
      );
    });

    it('should allow a new request if previous one was rejected', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);
      mockReturnsRepository.findByOrder.mockResolvedValue([{ ...mockReturnRequest, status: 'REJECTED' }]);
      mockReturnsRepository.create.mockResolvedValue(mockReturnRequest);

      const result = await service.createReturnRequest('user1', { orderId: 'order1', reason: 'reason' });

      expect(result).toEqual(mockReturnRequest);
    });
  });

  describe('approveReturn', () => {
    it('should approve a pending return request', async () => {
      const approved = { ...mockReturnRequest, status: 'APPROVED', refundAmount: 50 };
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.updateStatus.mockResolvedValue(approved);

      const result = await service.approveReturn({
        returnRequestId: 'return1',
        refundAmount: 50,
        adminNote: 'Approved',
      });

      expect(result.status).toBe('APPROVED');
      expect(mockReturnsRepository.updateStatus).toHaveBeenCalledWith('return1', 'APPROVED', 50, 'Approved');
    });

    it('should throw NotFoundException if return request not found', async () => {
      mockReturnsRepository.findById.mockResolvedValue(null);

      await expect(service.approveReturn({ returnRequestId: 'nonexistent', refundAmount: 50 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if return is not pending', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status: 'APPROVED' });

      await expect(service.approveReturn({ returnRequestId: 'return1', refundAmount: 50 })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('rejectReturn', () => {
    it('should reject a pending return request', async () => {
      const rejected = { ...mockReturnRequest, status: 'REJECTED' };
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.updateStatus.mockResolvedValue(rejected);

      const result = await service.rejectReturn({ returnRequestId: 'return1', adminNote: 'Not eligible' });

      expect(result.status).toBe('REJECTED');
    });

    it('should throw BadRequestException if return is not pending', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status: 'APPROVED' });

      await expect(service.rejectReturn({ returnRequestId: 'return1', adminNote: 'note' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('processRefund', () => {
    it('should process a refund for an approved return', async () => {
      const approvedReturn = {
        ...mockReturnRequest,
        status: 'APPROVED',
        refundAmount: { toString: () => '50', valueOf: () => 50 } as any,
      };
      const refundedReturn = { ...approvedReturn, status: 'REFUNDED' };

      mockReturnsRepository.findById.mockResolvedValue(approvedReturn);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue({ reference: 'txn_123' });
      mockedAxios.post.mockResolvedValue({ data: { status: true } });
      mockReturnsRepository.updateStatus.mockResolvedValue(refundedReturn);

      const result = await service.processRefund('return1');

      expect(mockReturnsRepository.updateStatus).toHaveBeenCalledWith('return1', 'REFUNDED');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.paystack.co/refund',
        expect.objectContaining({ transaction: 'txn_123' }),
        expect.any(Object),
      );
      expect(result.status).toBe('REFUNDED');
    });

    it('should throw BadRequestException if return is not approved', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status: 'PENDING' });

      await expect(service.processRefund('return1')).rejects.toThrow('Only approved return requests can be refunded');
    });

    it('should throw BadRequestException if refund amount is not set', async () => {
      mockReturnsRepository.findById.mockResolvedValue({
        ...mockReturnRequest,
        status: 'APPROVED',
        refundAmount: null,
      });

      await expect(service.processRefund('return1')).rejects.toThrow('Refund amount not set');
    });

    it('should throw BadRequestException if no payment transaction found', async () => {
      mockReturnsRepository.findById.mockResolvedValue({
        ...mockReturnRequest,
        status: 'APPROVED',
        refundAmount: 50,
      });
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue(null);

      await expect(service.processRefund('return1')).rejects.toThrow('No payment transaction found for this order');
    });

    it('should throw BadRequestException if Paystack refund fails', async () => {
      const approvedReturn = { ...mockReturnRequest, status: 'APPROVED', refundAmount: 50 };
      mockReturnsRepository.findById.mockResolvedValue(approvedReturn);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue({ reference: 'txn_123' });
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      await expect(service.processRefund('return1')).rejects.toThrow('Refund processing failed');
    });
  });

  describe('findByUser', () => {
    it('should return user return requests', async () => {
      mockReturnsRepository.findByUser.mockResolvedValue([mockReturnRequest]);

      const result = await service.findByUser('user1');

      expect(result).toEqual([mockReturnRequest]);
    });
  });

  describe('findAll', () => {
    it('should return all return requests', async () => {
      mockReturnsRepository.findAll.mockResolvedValue([mockReturnRequest]);

      const result = await service.findAll();

      expect(result).toEqual([mockReturnRequest]);
    });
  });
});
