import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { HashingService } from '../iam/hashing/hashing.service';
import { CreateUserInput } from './dto/create-user.input';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { User } from '@prisma/client';
import { Role } from './enums/role.enum';
import { UpdateUserInput } from './dto/update-user.input';
import { NotFoundException } from '@nestjs/common';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';

const mockUsersRepository = {
  create: jest.fn(),
  createWithAuthProvider: jest.fn(),
  createAuthProvider: jest.fn(),
  findById: jest.fn(),
  findByEmail: jest.fn(),
  findByProviderId: jest.fn(),
  findWithRelations: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockHashingService = {
  hash: jest.fn(),
  compare: jest.fn(),
};

const mockUser: User = {
  id: '1',
  name: 'John Doe',
  email: 'john@example.com',
  isActive: true,
  role: Role.USER,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
  profilePicture: null,
  phoneNumber: null,
  password: 'hashedPass',
  failedLoginAttempts: 0,
  lockedUntil: null,
};

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: jest.Mocked<UsersRepository>;
  let hashingService: jest.Mocked<typeof mockHashingService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: mockUsersRepository },
        { provide: HashingService, useValue: mockHashingService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    usersRepository = module.get<UsersRepository>(UsersRepository) as jest.Mocked<UsersRepository>;
    hashingService = module.get(HashingService);

    jest.clearAllMocks();
  });

  describe('createUserByCredentials', () => {
    it('should create a user with hashed password', async () => {
      const input: CreateUserInput = {
        email: 'test@example.com',
        password: 'password123',
        role: Role.USER,
        isActive: true,
        name: 'sean paul',
      };
      const hashedPassword = 'hashedPassword123';

      mockHashingService.hash.mockResolvedValue(hashedPassword);
      mockUsersRepository.create.mockResolvedValue({ ...mockUser, email: input.email, password: hashedPassword });

      const result = await service.createUserByCredentials(input);

      expect(hashingService.hash).toHaveBeenCalledWith('password123');
      expect(usersRepository.create).toHaveBeenCalledWith({ ...input, password: hashedPassword });
      expect(result.email).toEqual(input.email);
    });
  });

  describe('createUserByAuthProvider', () => {
    it('should create a user with an auth provider when email is new', async () => {
      const provider = 'google';
      const providerId = 'google123';
      const email = 'test@example.com';

      mockUsersRepository.findByEmail.mockResolvedValue(null);
      mockUsersRepository.createWithAuthProvider.mockResolvedValue({ ...mockUser, email });

      const result = await service.createUserByAuthProvider(providerId, provider, email);

      expect(usersRepository.createWithAuthProvider).toHaveBeenCalledWith(
        email,
        undefined,
        undefined,
        providerId,
        provider,
      );
      expect(result.email).toEqual(email);
    });

    it('should link auth provider to existing user when email already exists', async () => {
      const provider = 'google';
      const providerId = 'google123';
      const email = 'test@example.com';

      mockUsersRepository.findByEmail.mockResolvedValue(mockUser);
      mockUsersRepository.createAuthProvider.mockResolvedValue(undefined);

      const result = await service.createUserByAuthProvider(providerId, provider, email);

      expect(usersRepository.createAuthProvider).toHaveBeenCalledWith(mockUser.id, providerId, provider);
      expect(result).toEqual(mockUser);
    });
  });

  describe('findAll', () => {
    it('should return paginated users with filters', async () => {
      const filter: UserPaginateArgs = { first: 2, name: 'John', isActive: true };
      const user1 = { ...mockUser, id: '1', name: 'John Doe', email: 'john@example.com' };
      const user2 = { ...mockUser, id: '2', name: 'John Smith', email: 'john.smith@example.com' };
      const user3 = { ...mockUser, id: '3', name: 'John Extra', email: 'john.extra@example.com' };

      // Return 3 items (take+1) to signal there is a next page
      mockUsersRepository.findMany.mockResolvedValue([user1, user2, user3]);

      const result = await service.findAll(filter);

      expect(usersRepository.findMany).toHaveBeenCalledWith(
        { take: 3, skip: 0, cursor: undefined, orderBy: undefined, orderInAsc: undefined },
        { name: { contains: 'John', mode: 'insensitive' }, isActive: true },
      );
      expect(usersRepository.count).not.toHaveBeenCalled();
      expect(result).toEqual({
        edges: [
          { cursor: '1', node: user1 },
          { cursor: '2', node: user2 },
        ],
        pageInfo: { pageSize: 2, hasPreviousPage: false, hasNextPage: true },
      });
    });

    it('should handle pagination with cursor', async () => {
      const filter: UserPaginateArgs = { first: 1, after: '1' };
      const user2 = { ...mockUser, id: '2', name: 'Jane', email: 'jane@example.com' };
      const user3 = { ...mockUser, id: '3', name: 'Jim', email: 'jim@example.com' };

      // Return 2 items (take+1) to signal there is a next page
      mockUsersRepository.findMany.mockResolvedValue([user2, user3]);

      const result = await service.findAll(filter);

      expect(usersRepository.findMany).toHaveBeenCalledWith(
        { take: 2, skip: 1, cursor: { id: '1' }, orderBy: undefined, orderInAsc: undefined },
        {},
      );
      expect(result.pageInfo.hasNextPage).toBe(true);
    });
  });

  describe('findOne', () => {
    it('should return a user by ID', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);

      const result = await service.findOne('1');

      expect(usersRepository.findById).toHaveBeenCalledWith('1');
      expect(result).toEqual(mockUser);
    });
  });

  describe('findUserByEmail', () => {
    it('should return a user by email', async () => {
      mockUsersRepository.findByEmail.mockResolvedValue(mockUser);

      const result = await service.findUserByEmail('john@example.com');

      expect(usersRepository.findByEmail).toHaveBeenCalledWith('john@example.com');
      expect(result).toEqual(mockUser);
    });

    it('should return null if no user is found', async () => {
      mockUsersRepository.findByEmail.mockResolvedValue(null);

      const result = await service.findUserByEmail('nonexistent@example.com');

      expect(result).toBeNull();
    });
  });

  describe('findUserByProviderId', () => {
    it('should return the first user matching the provider ID', async () => {
      mockUsersRepository.findByProviderId.mockResolvedValue(mockUser);

      const result = await service.findUserByProviderId('google123');

      expect(usersRepository.findByProviderId).toHaveBeenCalledWith('google123');
      expect(result).toEqual(mockUser);
    });

    it('should return null if no users match the provider ID', async () => {
      mockUsersRepository.findByProviderId.mockResolvedValue(null);

      const result = await service.findUserByProviderId('nonexistent123');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update user profile fields', async () => {
      const input: UpdateUserInput = { name: 'Updated Name' };
      const updatedUser = { ...mockUser, name: 'Updated Name' };

      mockUsersRepository.update.mockResolvedValue(updatedUser);

      const result = await service.update('1', input);

      expect(usersRepository.update).toHaveBeenCalledWith('1', input);
      expect(result).toEqual(updatedUser);
    });
  });

  describe('changePassword', () => {
    it("should change the user's password", async () => {
      const input: ChangeUserPasswordInput = { oldPassword: 'oldPass123', newPassword: 'NewPass123' };
      const updatedUser = { ...mockUser, password: 'hashedNewPass' };

      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockHashingService.hash.mockResolvedValue('hashedNewPass');
      mockUsersRepository.update.mockResolvedValue(updatedUser);

      const result = await service.changePassword('1', input);

      expect(hashingService.compare).toHaveBeenCalledWith('oldPass123', mockUser.password);
      expect(hashingService.hash).toHaveBeenCalledWith('NewPass123');
      expect(usersRepository.update).toHaveBeenCalledWith('1', { password: 'hashedNewPass' });
      expect(result).toEqual(updatedUser);
    });

    it('should throw if old password is incorrect', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValue(false);

      await expect(
        service.changePassword('1', { oldPassword: 'wrongPass', newPassword: 'NewPass123' }),
      ).rejects.toThrow('Old password is incorrect');
    });

    it('should throw if new password matches old', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValue(true);

      await expect(
        service.changePassword('1', { oldPassword: 'oldPass123', newPassword: 'oldPass123' }),
      ).rejects.toThrow('New password must be different from old password');
    });
  });

  describe('remove', () => {
    it('should delete a user', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.delete.mockResolvedValue(mockUser);

      const result = await service.remove('1');

      expect(usersRepository.delete).toHaveBeenCalledWith('1');
      expect(result).toEqual(mockUser);
    });

    it('should throw if user not found', async () => {
      mockUsersRepository.findById.mockResolvedValue(null);

      await expect(service.remove('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('archiveUser', () => {
    it('should archive a user', async () => {
      const archivedUser = { ...mockUser, isActive: false };

      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.update.mockResolvedValue(archivedUser);

      const result = await service.archiveUser('1');

      expect(usersRepository.update).toHaveBeenCalledWith('1', { isActive: false });
      expect(result).toEqual(archivedUser);
    });
  });

  describe('deArchiveUser', () => {
    it('should de-archive a user', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      const activeUser = { ...mockUser, isActive: true };

      mockUsersRepository.findById.mockResolvedValue(inactiveUser);
      mockUsersRepository.update.mockResolvedValue(activeUser);

      const result = await service.deArchiveUser('1');

      expect(usersRepository.update).toHaveBeenCalledWith('1', { isActive: true });
      expect(result).toEqual(activeUser);
    });
  });
});
