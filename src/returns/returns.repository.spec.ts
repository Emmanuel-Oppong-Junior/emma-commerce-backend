import { Test, TestingModule } from '@nestjs/testing';
import { ReturnsRepository } from './returns.repository';
import { PrismaService } from '../prisma/prisma.service';
import { ReturnRequest } from '@prisma/client';

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

const mockPrismaReturnRequest = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  findUniqueOrThrow: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrisma = { returnRequest: mockPrismaReturnRequest };

describe('ReturnsRepository', () => {
  let repository: ReturnsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReturnsRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<ReturnsRepository>(ReturnsRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a return request', async () => {
      mockPrismaReturnRequest.create.mockResolvedValue(mockReturnRequest);

      const result = await repository.create({ orderId: 'order1', userId: 'user1', reason: 'Defective item' });

      expect(result).toEqual(mockReturnRequest);
      expect(mockPrismaReturnRequest.create).toHaveBeenCalledWith({
        data: { orderId: 'order1', userId: 'user1', reason: 'Defective item' },
      });
    });
  });

  describe('findById', () => {
    it('should find a return request by ID', async () => {
      mockPrismaReturnRequest.findUnique.mockResolvedValue(mockReturnRequest);

      const result = await repository.findById('return1');

      expect(result).toEqual(mockReturnRequest);
    });

    it('should return null if not found', async () => {
      mockPrismaReturnRequest.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByOrder', () => {
    it('should return all return requests for an order', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findByOrder('order1');

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({ where: { orderId: 'order1' } });
    });
  });

  describe('findByUser', () => {
    it('should return all return requests for a user ordered by date desc', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({
        where: { userId: 'user1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findAll', () => {
    it('should return all return requests ordered by date desc', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findAll();

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    });
  });

  describe('transitionStatus', () => {
    it('updates the request only while it still has the expected status, and returns it', async () => {
      const updated = { ...mockReturnRequest, status: 'APPROVED', refundAmount: 50, adminNote: 'Approved by admin' };
      mockPrismaReturnRequest.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaReturnRequest.findUniqueOrThrow.mockResolvedValue(updated);

      const result = await repository.transitionStatus('return1', 'PENDING', 'APPROVED', {
        refundAmount: 50,
        adminNote: 'Approved by admin',
      });

      expect(result).toEqual(updated);
      expect(mockPrismaReturnRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'return1', status: 'PENDING' },
        data: { status: 'APPROVED', refundAmount: 50, adminNote: 'Approved by admin' },
      });
    });

    it('returns null and reads nothing back when the request is missing or no longer has the expected status', async () => {
      mockPrismaReturnRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.transitionStatus('return1', 'PENDING', 'REJECTED', {})).resolves.toBeNull();
      expect(mockPrismaReturnRequest.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('rethrows database errors', async () => {
      mockPrismaReturnRequest.updateMany.mockRejectedValue(new Error('DB error'));

      await expect(repository.transitionStatus('return1', 'PENDING', 'APPROVED', {})).rejects.toThrow('DB error');
    });
  });
});
