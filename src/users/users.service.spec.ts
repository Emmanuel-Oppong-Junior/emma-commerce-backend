import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { HashingService } from '../iam/hashing/hashing.service';
import { CreateUserInput } from './dto/create-user.input';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { User } from '@prisma/client';
import { Role } from './enums/role.enum';
import { UpdateUserInput } from './dto/update-user.input';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { EmailVerificationService } from './email-verification.service';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';

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
  updateAndRevokeSessions: jest.fn(),
  delete: jest.fn(),
};

const mockEmailVerificationService = {
  requestEmailChange: jest.fn(),
};

const mockAuditService = createAuditServiceMock();

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
  passwordResetToken: null,
  passwordResetTokenExp: null,
  emailVerifiedAt: null,
  pendingEmail: null,
  emailVerificationToken: null,
  emailVerificationTokenExp: null,
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
        { provide: EmailVerificationService, useValue: mockEmailVerificationService },
        { provide: AuditService, useValue: mockAuditService },
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

      const result = await service.createUserByAuthProvider(providerId, provider, email, false);

      expect(usersRepository.createWithAuthProvider).toHaveBeenCalledWith(
        email,
        undefined,
        undefined,
        providerId,
        provider,
        null,
      );
      expect(result.email).toEqual(email);
    });

    it('refuses to attach a social identity to an existing account with the same email (pre-hijack)', async () => {
      mockUsersRepository.findByEmail.mockResolvedValue(mockUser);

      await expect(service.createUserByAuthProvider('google123', 'Google', mockUser.email, true)).rejects.toThrow(
        new ConflictException(
          'An account with this email already exists. Sign in with your email and password, then link Google from your account.',
        ),
      );
      expect(usersRepository.createAuthProvider).not.toHaveBeenCalled();
      expect(usersRepository.createWithAuthProvider).not.toHaveBeenCalled();
    });

    it('matches the existing account regardless of the case the provider uses for the email', async () => {
      mockUsersRepository.findByEmail.mockResolvedValue(mockUser);

      await expect(service.createUserByAuthProvider('google123', 'Google', ' John@Example.COM ', true)).rejects.toThrow(
        ConflictException,
      );
      expect(usersRepository.findByEmail).toHaveBeenCalledWith('john@example.com');
      expect(usersRepository.createWithAuthProvider).not.toHaveBeenCalled();
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
      mockUsersRepository.count.mockResolvedValue(3);

      const result = await service.findAll(filter);

      const expectedWhere = {
        role: { not: Role.SUPER_ADMIN },
        name: { contains: 'John', mode: 'insensitive' },
        isActive: true,
      };
      expect(usersRepository.findMany).toHaveBeenCalledWith(
        { take: 3, skip: 0, cursor: undefined, orderBy: undefined, orderInAsc: undefined },
        expectedWhere,
      );
      expect(usersRepository.count).toHaveBeenCalledWith(expectedWhere);
      expect(result).toEqual({
        edges: [
          { cursor: '1', node: user1 },
          { cursor: '2', node: user2 },
        ],
        pageInfo: { pageSize: 2, hasPreviousPage: false, hasNextPage: true, totalCount: 3 },
      });
    });

    it('should exclude super admins even when filtering by the SUPER_ADMIN role', async () => {
      mockUsersRepository.findMany.mockResolvedValue([]);
      mockUsersRepository.count.mockResolvedValue(0);

      await service.findAll({ first: 10, role: Role.SUPER_ADMIN });

      const expectedWhere = { role: { not: Role.SUPER_ADMIN, equals: Role.SUPER_ADMIN } };
      expect(usersRepository.findMany).toHaveBeenCalledWith(expect.any(Object), expectedWhere);
      expect(usersRepository.count).toHaveBeenCalledWith(expectedWhere);
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
        { role: { not: Role.SUPER_ADMIN } },
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

    it('stores a new email as pending once the current password is confirmed, keeping the current email', async () => {
      const pendingUser = { ...mockUser, pendingEmail: 'new@example.com' };
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValue(true);
      mockEmailVerificationService.requestEmailChange.mockResolvedValue(pendingUser);

      const result = await service.update('1', { email: 'new@example.com', name: 'Renamed' }, 'Current@123');

      expect(hashingService.compare).toHaveBeenCalledWith('Current@123', mockUser.password);
      expect(mockEmailVerificationService.requestEmailChange).toHaveBeenCalledWith(mockUser, 'new@example.com', {
        name: 'Renamed',
      });
      expect(usersRepository.update).not.toHaveBeenCalled();
      expect(usersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
      expect(result).toEqual(pendingUser);
    });

    it('rejects an email change without the current password', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);

      await expect(service.update('1', { email: 'new@example.com' })).rejects.toThrow(
        new BadRequestException('currentPassword is required to change your email'),
      );
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it('rejects an email change with a wrong current password, applying none of the changes', async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValue(false);

      await expect(service.update('1', { email: 'new@example.com', name: 'Renamed' }, 'Wrong@123')).rejects.toThrow(
        new ForbiddenException('Current password is incorrect'),
      );
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it('rejects an email change on an account that has no password (social sign-in only)', async () => {
      mockUsersRepository.findById.mockResolvedValue({ ...mockUser, password: null });

      await expect(service.update('1', { email: 'new@example.com' }, 'anything')).rejects.toThrow(BadRequestException);
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
    });

    it('updates other fields without a password when the submitted email is unchanged', async () => {
      const input: UpdateUserInput = { email: mockUser.email, name: 'Renamed' };
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.update.mockResolvedValue({ ...mockUser, name: 'Renamed' });

      await service.update('1', input);

      expect(usersRepository.update).toHaveBeenCalledWith('1', { name: 'Renamed' });
      expect(usersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
    });
  });

  describe('adminUpdateUser', () => {
    it("sends an admin's change of a customer's email through verification of the new address", async () => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockEmailVerificationService.requestEmailChange.mockResolvedValue({
        ...mockUser,
        pendingEmail: 'new@example.com',
      });

      await service.adminUpdateUser('1', { email: 'new@example.com' }, Role.ADMIN, 'admin1');

      expect(mockEmailVerificationService.requestEmailChange).toHaveBeenCalledWith(
        mockUser,
        'new@example.com',
        {},
        AUDIT_TX,
      );
      expect(hashingService.compare).not.toHaveBeenCalled();
      expect(usersRepository.update).not.toHaveBeenCalled();
      expect(usersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
    });

    it('keeps sessions when an admin edits other fields', async () => {
      const input: UpdateUserInput = { name: 'Renamed' };
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.update.mockResolvedValue({ ...mockUser, ...input });

      await service.adminUpdateUser('1', input, Role.ADMIN, 'admin1');

      expect(usersRepository.update).toHaveBeenCalledWith('1', input, AUDIT_TX);
      expect(usersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it("should change the user's password and revoke all of their refresh tokens", async () => {
      const input: ChangeUserPasswordInput = { oldPassword: 'oldPass123', newPassword: 'NewPass123' };
      const updatedUser = { ...mockUser, password: 'hashedNewPass' };

      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockHashingService.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockHashingService.hash.mockResolvedValue('hashedNewPass');
      mockUsersRepository.updateAndRevokeSessions.mockResolvedValue(updatedUser);

      const result = await service.changePassword('1', input);

      expect(hashingService.compare).toHaveBeenCalledWith('oldPass123', mockUser.password);
      expect(hashingService.hash).toHaveBeenCalledWith('NewPass123');
      expect(usersRepository.updateAndRevokeSessions).toHaveBeenCalledWith('1', { password: 'hashedNewPass' });
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

      const result = await service.remove('1', Role.ADMIN, 'admin1');

      expect(usersRepository.delete).toHaveBeenCalledWith('1', AUDIT_TX);
      expect(result).toEqual(mockUser);
    });

    it('should throw if user not found', async () => {
      mockUsersRepository.findById.mockResolvedValue(null);

      await expect(service.remove('1', Role.ADMIN, 'admin1')).rejects.toThrow(NotFoundException);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  describe('archiveUser', () => {
    it('should archive a user and revoke all of their refresh tokens', async () => {
      const archivedUser = { ...mockUser, isActive: false };

      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.updateAndRevokeSessions.mockResolvedValue(archivedUser);

      const result = await service.archiveUser('1', Role.ADMIN, 'admin1');

      expect(usersRepository.updateAndRevokeSessions).toHaveBeenCalledWith('1', { isActive: false }, AUDIT_TX);
      expect(result).toEqual(archivedUser);
    });
  });

  describe('deArchiveUser', () => {
    it('should de-archive a user', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      const activeUser = { ...mockUser, isActive: true };

      mockUsersRepository.findById.mockResolvedValue(inactiveUser);
      mockUsersRepository.update.mockResolvedValue(activeUser);

      const result = await service.deArchiveUser('1', Role.ADMIN, 'admin1');

      expect(usersRepository.update).toHaveBeenCalledWith('1', { isActive: true }, AUDIT_TX);
      expect(result).toEqual(activeUser);
    });
  });

  describe('admin account management', () => {
    const adminTarget: User = { ...mockUser, id: 'admin-2', role: Role.ADMIN };
    const superAdminTarget: User = { ...mockUser, id: 'super-1', role: Role.SUPER_ADMIN };

    const adminActions: Array<[string, (id: string, actorRole: Role) => Promise<unknown>]> = [
      [
        'adminUpdateUser',
        (id, actorRole) => service.adminUpdateUser(id, { email: 'taken@example.com' }, actorRole, 'actor1'),
      ],
      ['remove', (id, actorRole) => service.remove(id, actorRole, 'actor1')],
      ['archiveUser', (id, actorRole) => service.archiveUser(id, actorRole, 'actor1')],
      ['deArchiveUser', (id, actorRole) => service.deArchiveUser(id, actorRole, 'actor1')],
    ];

    it.each(adminActions)('%s rejects an ADMIN acting on another ADMIN account', async (_name, act) => {
      mockUsersRepository.findById.mockResolvedValue(adminTarget);

      await expect(act(adminTarget.id, Role.ADMIN)).rejects.toThrow(ForbiddenException);
      expect(mockAuditService.log).not.toHaveBeenCalled();
      expect(mockUsersRepository.update).not.toHaveBeenCalled();
      expect(mockUsersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
      expect(mockUsersRepository.delete).not.toHaveBeenCalled();
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
    });

    it.each(adminActions)('%s lets a SUPER_ADMIN act on an ADMIN account', async (_name, act) => {
      mockUsersRepository.findById.mockResolvedValue(adminTarget);
      mockUsersRepository.update.mockResolvedValue(adminTarget);
      mockUsersRepository.updateAndRevokeSessions.mockResolvedValue(adminTarget);
      mockUsersRepository.delete.mockResolvedValue(adminTarget);
      mockEmailVerificationService.requestEmailChange.mockResolvedValue(adminTarget);

      await expect(act(adminTarget.id, Role.SUPER_ADMIN)).resolves.toEqual(adminTarget);
    });

    it.each(adminActions)('%s rejects any caller acting on a SUPER_ADMIN account', async (_name, act) => {
      mockUsersRepository.findById.mockResolvedValue(superAdminTarget);

      await expect(act(superAdminTarget.id, Role.ADMIN)).rejects.toThrow(ForbiddenException);
      await expect(act(superAdminTarget.id, Role.SUPER_ADMIN)).rejects.toThrow(ForbiddenException);
      expect(mockUsersRepository.update).not.toHaveBeenCalled();
      expect(mockUsersRepository.updateAndRevokeSessions).not.toHaveBeenCalled();
      expect(mockUsersRepository.delete).not.toHaveBeenCalled();
      expect(mockEmailVerificationService.requestEmailChange).not.toHaveBeenCalled();
    });

    it.each(adminActions)('%s lets an ADMIN act on a customer account', async (_name, act) => {
      mockUsersRepository.findById.mockResolvedValue(mockUser);
      mockUsersRepository.update.mockResolvedValue(mockUser);
      mockUsersRepository.updateAndRevokeSessions.mockResolvedValue(mockUser);
      mockUsersRepository.delete.mockResolvedValue(mockUser);
      mockEmailVerificationService.requestEmailChange.mockResolvedValue(mockUser);

      await expect(act(mockUser.id, Role.ADMIN)).resolves.toEqual(mockUser);
    });
  });

  describe('audit trail', () => {
    const inactiveUser: User = { ...mockUser, isActive: false };

    it('records who created an account and with which role, without the password hash', async () => {
      const input: CreateUserInput = {
        email: 'staff@example.com',
        password: 'password123',
        role: Role.ADMIN,
        isActive: true,
        name: 'staff member',
      };
      mockHashingService.hash.mockResolvedValue('hashed');
      mockUsersRepository.create.mockResolvedValue({ ...mockUser, id: 'new1', role: Role.ADMIN, password: 'hashed' });

      await service.adminCreateUser(input, 'super1');

      expect(usersRepository.create).toHaveBeenCalledWith({ ...input, password: 'hashed' }, AUDIT_TX);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'User',
          entityId: 'new1',
          action: 'CREATE',
          userId: 'super1',
          details: { role: Role.ADMIN, isActive: true },
        },
        AUDIT_TX,
      );
      expect(JSON.stringify(mockAuditService.log.mock.calls)).not.toContain('hashed');
    });

    it('does not audit self sign-up through createUserByCredentials', async () => {
      mockHashingService.hash.mockResolvedValue('hashed');
      mockUsersRepository.create.mockResolvedValue(mockUser);

      await service.createUserByCredentials({
        email: 'me@example.com',
        password: 'password123',
        role: Role.USER,
        isActive: true,
        name: 'me myself',
      });

      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it.each<[string, () => Promise<unknown>, User, object]>([
      [
        'adminUpdateUser (profile fields)',
        () => service.adminUpdateUser('1', { name: 'Renamed', phoneNumber: undefined }, Role.ADMIN, 'admin1'),
        mockUser,
        {
          action: 'UPDATE',
          details: { fields: ['name'], role: Role.USER, emailChangePending: false },
        },
      ],
      [
        'adminUpdateUser (email)',
        () => service.adminUpdateUser('1', { email: 'new@example.com' }, Role.ADMIN, 'admin1'),
        mockUser,
        {
          action: 'UPDATE',
          details: { fields: ['email'], role: Role.USER, emailChangePending: true },
        },
      ],
      [
        'remove',
        () => service.remove('1', Role.ADMIN, 'admin1'),
        mockUser,
        { action: 'DELETE', details: { before: { role: Role.USER, isActive: true } } },
      ],
      [
        'archiveUser',
        () => service.archiveUser('1', Role.ADMIN, 'admin1'),
        mockUser,
        { action: 'ARCHIVE', details: { role: Role.USER, changes: { isActive: { from: true, to: false } } } },
      ],
      [
        'deArchiveUser',
        () => service.deArchiveUser('1', Role.ADMIN, 'admin1'),
        inactiveUser,
        { action: 'RESTORE', details: { role: Role.USER, changes: { isActive: { from: false, to: true } } } },
      ],
    ])(
      '%s writes an audit entry with the acting admin in the same transaction',
      async (_name, act, target, expected) => {
        mockUsersRepository.findById.mockResolvedValue(target);
        mockUsersRepository.update.mockImplementation(async (_id, data) => ({ ...target, ...data }));
        mockUsersRepository.updateAndRevokeSessions.mockImplementation(async (_id, data) => ({ ...target, ...data }));
        mockUsersRepository.delete.mockResolvedValue(target);
        mockEmailVerificationService.requestEmailChange.mockResolvedValue(target);

        await act();

        expect(mockAuditService.log).toHaveBeenCalledTimes(1);
        expect(mockAuditService.log).toHaveBeenCalledWith(
          { entity: 'User', entityId: '1', userId: 'admin1', ...expected },
          AUDIT_TX,
        );
        expect(JSON.stringify(mockAuditService.log.mock.calls)).not.toMatch(/new@example\.com|John Doe|hashedPass/);
      },
    );
  });
});
