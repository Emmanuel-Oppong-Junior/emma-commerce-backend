import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsRepository } from './returns.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ReturnRequest } from '@prisma/client';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { RefundsService } from './refunds.service';
import { RefundRepository } from './refund.repository';

const mockReturnsRepository = {
  create: jest.fn(),
  findById: jest.fn(),
  findByOrder: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  transitionStatus: jest.fn(),
};

const mockPrisma = {
  order: { findUnique: jest.fn() },
  paymentAttempt: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const mockAuditService = createAuditServiceMock();
const mockRefundsService = { openForReturn: jest.fn(), send: jest.fn() };
const mockRefundRepository = { findByReturnRequest: jest.fn() };

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
        { provide: AuditService, useValue: mockAuditService },
        { provide: RefundsService, useValue: mockRefundsService },
        { provide: RefundRepository, useValue: mockRefundRepository },
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
      mockReturnsRepository.transitionStatus.mockResolvedValue(approved);

      const result = await service.approveReturn(
        { returnRequestId: 'return1', refundAmount: 50, adminNote: 'Approved' },
        'admin1',
      );

      expect(result.status).toBe('APPROVED');
      expect(mockReturnsRepository.transitionStatus).toHaveBeenCalledWith(
        'return1',
        'PENDING',
        'APPROVED',
        { refundAmount: 50, adminNote: 'Approved' },
        AUDIT_TX,
      );
    });

    it('audits the approval with the admin, the status change and the refund amount in the same transaction', async () => {
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.transitionStatus.mockResolvedValue({
        ...mockReturnRequest,
        status: 'APPROVED',
        refundAmount: 50,
      });

      await service.approveReturn({ returnRequestId: 'return1', refundAmount: 50 }, 'admin1');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'ReturnRequest',
          entityId: 'return1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: { orderId: 'order1', from: 'PENDING', to: 'APPROVED', refundAmount: '50' },
        },
        AUDIT_TX,
      );
    });

    it('fails with CONFLICT and audits nothing when another request reviewed it after it was read', async () => {
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.transitionStatus.mockResolvedValue(null);

      await expect(service.approveReturn({ returnRequestId: 'return1', refundAmount: 50 }, 'admin1')).rejects.toThrow(
        ConflictException,
      );
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if return request not found', async () => {
      mockReturnsRepository.findById.mockResolvedValue(null);

      await expect(
        service.approveReturn({ returnRequestId: 'nonexistent', refundAmount: 50 }, 'admin1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if return is not pending', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status: 'APPROVED' });

      await expect(service.approveReturn({ returnRequestId: 'return1', refundAmount: 50 }, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  describe('rejectReturn', () => {
    it('should reject a pending return request', async () => {
      const rejected = { ...mockReturnRequest, status: 'REJECTED' };
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.transitionStatus.mockResolvedValue(rejected);

      const result = await service.rejectReturn({ returnRequestId: 'return1', adminNote: 'Not eligible' }, 'admin1');

      expect(result.status).toBe('REJECTED');
      expect(mockReturnsRepository.transitionStatus).toHaveBeenCalledWith(
        'return1',
        'PENDING',
        'REJECTED',
        { adminNote: 'Not eligible' },
        AUDIT_TX,
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'ReturnRequest',
          entityId: 'return1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: { orderId: 'order1', from: 'PENDING', to: 'REJECTED', refundAmount: null },
        },
        AUDIT_TX,
      );
    });

    it('fails with CONFLICT and audits nothing when another request reviewed it after it was read', async () => {
      mockReturnsRepository.findById.mockResolvedValue(mockReturnRequest);
      mockReturnsRepository.transitionStatus.mockResolvedValue(null);

      await expect(service.rejectReturn({ returnRequestId: 'return1', adminNote: 'note' }, 'admin1')).rejects.toThrow(
        ConflictException,
      );
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if return is not pending', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status: 'APPROVED' });

      await expect(service.rejectReturn({ returnRequestId: 'return1', adminNote: 'note' }, 'admin1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('processRefund', () => {
    const approvedReturn = {
      ...mockReturnRequest,
      status: 'APPROVED',
      refundAmount: new Prisma.Decimal(50),
    } as unknown as ReturnRequest;
    const refundedReturn = { ...approvedReturn, status: 'REFUNDED' };

    it('opens the refund on the paying attempt, then sends it, and returns the refunded request', async () => {
      mockReturnsRepository.findById.mockResolvedValue(approvedReturn);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue({ id: 'attempt1', reference: 'txn_123' });
      mockRefundsService.openForReturn.mockResolvedValue({ id: 'refund1' });
      mockRefundsService.send.mockResolvedValue({ refund: { id: 'refund1' }, returnRequest: refundedReturn });

      const result = await service.processRefund('return1', 'admin1');

      expect(result).toBe(refundedReturn);
      expect(mockPrisma.paymentAttempt.findFirst).toHaveBeenCalledWith({
        where: { intent: { orderId: 'order1' }, status: 'COMPLETED', reference: { not: null } },
        orderBy: [{ reviewReason: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      });
      expect(mockRefundsService.openForReturn).toHaveBeenCalledWith(approvedReturn, 'attempt1', 'admin1');
      expect(mockRefundsService.send).toHaveBeenCalledWith('refund1', 'admin1');
    });

    it('resends the existing refund of a REFUND_PENDING request instead of opening another', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...approvedReturn, status: 'REFUND_PENDING' });
      mockRefundRepository.findByReturnRequest.mockResolvedValue({ id: 'refund1' });
      mockRefundsService.send.mockResolvedValue({ refund: { id: 'refund1' }, returnRequest: refundedReturn });

      await service.processRefund('return1', 'admin1');

      expect(mockRefundsService.openForReturn).not.toHaveBeenCalled();
      expect(mockRefundsService.send).toHaveBeenCalledWith('refund1', 'admin1');
    });

    it('fails with CONFLICT for a REFUND_PENDING request without a refund', async () => {
      mockReturnsRepository.findById.mockResolvedValue({ ...approvedReturn, status: 'REFUND_PENDING' });
      mockRefundRepository.findByReturnRequest.mockResolvedValue(null);

      await expect(service.processRefund('return1', 'admin1')).rejects.toThrow(ConflictException);
      expect(mockRefundsService.send).not.toHaveBeenCalled();
    });

    it('does not send when another request claimed the return first', async () => {
      mockReturnsRepository.findById.mockResolvedValue(approvedReturn);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue({ id: 'attempt1', reference: 'txn_123' });
      mockRefundsService.openForReturn.mockRejectedValue(new ConflictException('no longer APPROVED'));

      await expect(service.processRefund('return1', 'admin1')).rejects.toThrow(ConflictException);
      expect(mockRefundsService.send).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'REJECTED', 'REFUNDED'])('should throw BadRequestException if return is %s', async (status) => {
      mockReturnsRepository.findById.mockResolvedValue({ ...mockReturnRequest, status });

      await expect(service.processRefund('return1', 'admin1')).rejects.toThrow(
        'Only approved return requests can be refunded',
      );
      expect(mockRefundsService.send).not.toHaveBeenCalled();
    });

    it.each([
      ['not set', null],
      ['zero', new Prisma.Decimal(0)],
    ])('should throw BadRequestException if refund amount is %s', async (_case, refundAmount) => {
      mockReturnsRepository.findById.mockResolvedValue({ ...approvedReturn, refundAmount });

      await expect(service.processRefund('return1', 'admin1')).rejects.toThrow('Refund amount not set');
      expect(mockRefundsService.openForReturn).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if no payment transaction found', async () => {
      mockReturnsRepository.findById.mockResolvedValue(approvedReturn);
      mockPrisma.paymentAttempt.findFirst.mockResolvedValue(null);

      await expect(service.processRefund('return1', 'admin1')).rejects.toThrow(
        'No payment transaction found for this order',
      );
      expect(mockRefundsService.openForReturn).not.toHaveBeenCalled();
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
