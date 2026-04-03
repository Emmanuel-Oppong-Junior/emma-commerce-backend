import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, User } from '@prisma/client';
import { Role } from './enums/role.enum';

const mockUser: User = {
  id: 'user1',
  name: 'John Doe',
  email: 'john@example.com',
  password: 'hashed',
  role: Role.USER,
  isActive: true,
  profilePicture: null,
  phoneNumber: null,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  passwordResetToken: null,
  passwordResetTokenExp: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaUser = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaAuthProvider = { create: jest.fn() };
const mockPrismaRefreshToken = {
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
  create: jest.fn(),
};

const mockPrisma = {
  user: mockPrismaUser,
  authProvider: mockPrismaAuthProvider,
  refreshToken: mockPrismaRefreshToken,
};

describe('UsersRepository', () => {
  let repository: UsersRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<UsersRepository>(UsersRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a user', async () => {
      mockPrismaUser.create.mockResolvedValue(mockUser);

      const result = await repository.create({ email: 'john@example.com', password: 'hashed' } as any);

      expect(result).toEqual(mockUser);
    });

    it('should throw ConflictException on P2002 (duplicate email)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaUser.create.mockRejectedValue(prismaError);

      await expect(repository.create({ email: 'dup@example.com' } as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaUser.create.mockRejectedValue(new Error('Unknown error'));

      await expect(repository.create({ email: 'x@x.com' } as any)).rejects.toThrow('Unknown error');
    });
  });

  describe('createWithAuthProvider', () => {
    it('should create a user with auth provider', async () => {
      mockPrismaUser.create.mockResolvedValue(mockUser);

      const result = await repository.createWithAuthProvider(
        'test@example.com',
        'John',
        undefined,
        'google123',
        'google',
      );

      expect(mockPrismaUser.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'test@example.com' }) }),
      );
      expect(result).toEqual(mockUser);
    });
  });

  describe('createAuthProvider', () => {
    it('should create an auth provider record', async () => {
      mockPrismaAuthProvider.create.mockResolvedValue(undefined);

      await repository.createAuthProvider('user1', 'google123', 'google');

      expect(mockPrismaAuthProvider.create).toHaveBeenCalledWith({
        data: { userId: 'user1', providerId: 'google123', provider: 'google' },
      });
    });
  });

  describe('findById', () => {
    it('should find a user by ID', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockUser);

      const result = await repository.findById('user1');

      expect(result).toEqual(mockUser);
      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({ where: { id: 'user1' } });
    });

    it('should return null if not found', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('should find a user by email', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockUser);

      const result = await repository.findByEmail('john@example.com');

      expect(result).toEqual(mockUser);
    });
  });

  describe('findByProviderId', () => {
    it('should find a user by provider ID', async () => {
      mockPrismaUser.findFirst.mockResolvedValue(mockUser);

      const result = await repository.findByProviderId('google123');

      expect(result).toEqual(mockUser);
    });
  });

  describe('findWithRelations', () => {
    it('should find a user with all relations', async () => {
      const userWithRelations = { ...mockUser, addresses: [], cart: null, wishlist: null, order: [] };
      mockPrismaUser.findUnique.mockResolvedValue(userWithRelations);

      const result = await repository.findWithRelations('user1');

      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: expect.objectContaining({ addresses: true }) }),
      );
      expect(result).toEqual(userWithRelations);
    });
  });

  describe('findMany', () => {
    it('should find many users with ordering and pagination', async () => {
      mockPrismaUser.findMany.mockResolvedValue([mockUser]);

      const result = await repository.findMany(
        { take: 10, skip: 0, orderBy: 'name', orderInAsc: true },
        { isActive: true },
      );

      expect(result).toEqual([mockUser]);
      expect(mockPrismaUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 0, orderBy: { name: 'asc' } }),
      );
    });

    it('should default to name:asc ordering when orderBy not provided', async () => {
      mockPrismaUser.findMany.mockResolvedValue([mockUser]);

      await repository.findMany({ take: 5, skip: 0 }, {});

      expect(mockPrismaUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { name: 'asc' } }));
    });
  });

  describe('count', () => {
    it('should return user count', async () => {
      mockPrismaUser.count.mockResolvedValue(42);

      const result = await repository.count({ isActive: true });

      expect(result).toBe(42);
    });
  });

  describe('update', () => {
    it('should update a user', async () => {
      const updated = { ...mockUser, name: 'Updated' };
      mockPrismaUser.update.mockResolvedValue(updated);

      const result = await repository.update('user1', { name: 'Updated' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaUser.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a user', async () => {
      mockPrismaUser.delete.mockResolvedValue(mockUser);

      const result = await repository.delete('user1');

      expect(result).toEqual(mockUser);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaUser.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('refresh token operations', () => {
    it('should find a refresh token', async () => {
      const token = { id: 'rt1', tokenHash: 'hash123', revoked: false };
      mockPrismaRefreshToken.findUnique.mockResolvedValue(token);

      const result = await repository.findRefreshToken('hash123');

      expect(result).toEqual(token);
    });

    it('should revoke a refresh token', async () => {
      mockPrismaRefreshToken.update.mockResolvedValue(undefined);

      await repository.revokeRefreshToken('hash123');

      expect(mockPrismaRefreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: 'hash123' },
        data: { revoked: true },
      });
    });

    it('should revoke refresh tokens by hash (many)', async () => {
      mockPrismaRefreshToken.updateMany.mockResolvedValue({ count: 1 });

      await repository.revokeRefreshTokensByHash('hash123');

      expect(mockPrismaRefreshToken.updateMany).toHaveBeenCalled();
    });

    it('should delete expired refresh tokens', async () => {
      mockPrismaRefreshToken.deleteMany.mockResolvedValue({ count: 3 });

      await repository.deleteExpiredRefreshTokens('user1');

      expect(mockPrismaRefreshToken.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'user1' }) }),
      );
    });

    it('should create a refresh token', async () => {
      mockPrismaRefreshToken.create.mockResolvedValue(undefined);

      await repository.createRefreshToken('user1', 'hash123', new Date());

      expect(mockPrismaRefreshToken.create).toHaveBeenCalled();
    });
  });

  describe('password reset operations', () => {
    it('should save a password reset token', async () => {
      mockPrismaUser.update.mockResolvedValue(mockUser);

      await repository.savePasswordResetToken('user1', 'resetHash', new Date());

      expect(mockPrismaUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user1' },
          data: expect.objectContaining({ passwordResetToken: 'resetHash' }),
        }),
      );
    });

    it('should find a user by reset token', async () => {
      mockPrismaUser.findFirst.mockResolvedValue(mockUser);

      const result = await repository.findByResetToken('resetHash');

      expect(result).toEqual(mockUser);
    });

    it('should clear a password reset token', async () => {
      mockPrismaUser.update.mockResolvedValue(mockUser);

      await repository.clearPasswordResetToken('user1');

      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'user1' },
        data: { passwordResetToken: null, passwordResetTokenExp: null },
      });
    });
  });
});
