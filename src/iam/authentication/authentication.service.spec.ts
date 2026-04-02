import { Test, TestingModule } from '@nestjs/testing';
import { AuthenticationService } from './authentication.service';
import { UsersService } from '../../users/users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { HashingService } from '../hashing/hashing.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import jwtConfig from '../config/jwt.config';
import { Role } from '../../users/enums/role.enum';
import { SignUpInput } from './dto/sign-up.input';
import { SignInInput } from './dto/sign-in.input';
import { User } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';

const mockUsersService = {
  findUserByEmail: jest.fn(),
  createUserByCredentials: jest.fn(),
  updateLastLogin: jest.fn(),
  findOne: jest.fn(),
  recordFailedLoginAttempt: jest.fn(),
  resetFailedLoginAttempts: jest.fn(),
};

const mockPrismaService = {
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockHashingService = {
  hash: jest.fn(),
  compare: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn(),
  verifyAsync: jest.fn(),
};

const mockJwtConfig = {
  secret: 'test-secret',
  refreshSecret: 'test-refresh-secret',
  audience: 'test-audience',
  issuer: 'test-issuer',
  accessTokenTtl: 3600,
  refreshTokenTtl: 86400,
};

const baseUser: Partial<User> = {
  id: '1',
  email: 'test@example.com',
  role: Role.USER,
  isActive: true,
  password: 'hashedPass',
  failedLoginAttempts: 0,
  lockedUntil: null,
};

describe('AuthenticationService', () => {
  let service: AuthenticationService;
  let usersService: jest.Mocked<typeof mockUsersService>;
  let hashingService: jest.Mocked<typeof mockHashingService>;
  let jwtService: jest.Mocked<typeof mockJwtService>;
  let prisma: jest.Mocked<typeof mockPrismaService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(jwtConfig)],
      providers: [
        AuthenticationService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: HashingService, useValue: mockHashingService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: jwtConfig.KEY, useValue: mockJwtConfig },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
    usersService = module.get(UsersService);
    hashingService = module.get(HashingService);
    jwtService = module.get(JwtService);
    prisma = module.get(PrismaService);

    jest.clearAllMocks();
  });

  describe('signUp', () => {
    it('should sign up a new user and return tokens', async () => {
      const input: SignUpInput = { email: 'test@example.com', password: 'password123', name: 'Test' };

      mockUsersService.findUserByEmail.mockResolvedValue(null);
      mockUsersService.createUserByCredentials.mockResolvedValue(baseUser);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockPrismaService.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.refreshToken.create.mockResolvedValue({});
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.signUp(input);

      expect(usersService.findUserByEmail).toHaveBeenCalledWith(input.email);
      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });

    it('should throw ConflictException if user already exists', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue({ id: '1' });

      await expect(service.signUp({ email: 'test@example.com', password: 'p', name: 'T' })).rejects.toThrow(
        'User already exist!',
      );
    });
  });

  describe('signIn', () => {
    it('should sign in successfully and return tokens', async () => {
      const input: SignInInput = { email: 'test@example.com', password: 'password123' };

      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockPrismaService.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.refreshToken.create.mockResolvedValue({});
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.signIn(input);

      expect(hashingService.compare).toHaveBeenCalledWith(input.password, baseUser.password);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });

    it('should throw if user not found', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(null);

      await expect(service.signIn({ email: 'x@x.com', password: 'p' })).rejects.toThrow('Invalid email or password');
    });

    it('should increment failed attempts and throw on wrong password', async () => {
      mockUsersService.findUserByEmail.mockResolvedValue(baseUser);
      mockHashingService.compare.mockResolvedValue(false);
      mockUsersService.recordFailedLoginAttempt.mockResolvedValue(undefined);

      await expect(service.signIn({ email: baseUser.email, password: 'wrong' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(usersService.recordFailedLoginAttempt).toHaveBeenCalledWith(baseUser);
    });

    it('should throw if account is locked', async () => {
      const lockedUser = { ...baseUser, lockedUntil: new Date(Date.now() + 60_000) };
      mockUsersService.findUserByEmail.mockResolvedValue(lockedUser);

      await expect(service.signIn({ email: baseUser.email, password: 'any' })).rejects.toThrow(UnauthorizedException);
    });

    it('should reset failed attempts after successful sign-in with prior failures', async () => {
      const userWithAttempts = { ...baseUser, failedLoginAttempts: 3 };
      mockUsersService.findUserByEmail.mockResolvedValue(userWithAttempts);
      mockHashingService.compare.mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockPrismaService.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.refreshToken.create.mockResolvedValue({});
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);
      mockUsersService.resetFailedLoginAttempts.mockResolvedValue(undefined);

      await service.signIn({ email: baseUser.email, password: 'correct' });

      expect(usersService.resetFailedLoginAttempts).toHaveBeenCalledWith(userWithAttempts.id);
    });
  });

  describe('refreshToken', () => {
    it('should issue new tokens and revoke the old one (rotation)', async () => {
      const rawToken = 'valid-refresh-token';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const storedToken = { tokenHash, revoked: false };

      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1' });
      mockPrismaService.refreshToken.findUnique.mockResolvedValue(storedToken);
      mockUsersService.findOne.mockResolvedValue(baseUser);
      mockPrismaService.refreshToken.update.mockResolvedValue({});
      mockJwtService.signAsync.mockResolvedValueOnce('new-access').mockResolvedValueOnce('new-refresh');
      mockPrismaService.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.refreshToken.create.mockResolvedValue({});
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.refreshToken({ refreshToken: rawToken });

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash },
        data: { revoked: true },
      });
      expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    });

    it('should throw if token is revoked', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1' });
      mockPrismaService.refreshToken.findUnique.mockResolvedValue({ tokenHash: 'h', revoked: true });

      await expect(service.refreshToken({ refreshToken: 'token' })).rejects.toThrow(UnauthorizedException);
    });

    it('should throw if token hash is not found in DB', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1' });
      mockPrismaService.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refreshToken({ refreshToken: 'token' })).rejects.toThrow(UnauthorizedException);
    });

    it('should throw if user is inactive', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: '1' });
      mockPrismaService.refreshToken.findUnique.mockResolvedValue({ tokenHash: 'h', revoked: false });
      mockUsersService.findOne.mockResolvedValue({ ...baseUser, isActive: false });

      await expect(service.refreshToken({ refreshToken: 'token' })).rejects.toThrow('Account is inactive');
    });

    it('should throw if JWT verification fails', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

      await expect(service.refreshToken({ refreshToken: 'bad-token' })).rejects.toThrow(
        'Invalid or expired refresh token',
      );
    });
  });

  describe('signOut', () => {
    it('should revoke the refresh token and return true', async () => {
      mockPrismaService.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.signOut('some-refresh-token');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: createHash('sha256').update('some-refresh-token').digest('hex') },
        data: { revoked: true },
      });
      expect(result).toBe(true);
    });

    it('should return true even if the token is not found (idempotent)', async () => {
      mockPrismaService.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.signOut('unknown-token');

      expect(result).toBe(true);
    });
  });

  describe('generateTokens', () => {
    it('should generate tokens, save hash, and update last login', async () => {
      mockJwtService.signAsync.mockResolvedValueOnce('access').mockResolvedValueOnce('refresh');
      mockPrismaService.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.refreshToken.create.mockResolvedValue({});
      mockUsersService.updateLastLogin.mockResolvedValue(undefined);

      const result = await service.generateTokens(baseUser as User);

      expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      expect(usersService.updateLastLogin).toHaveBeenCalledWith(baseUser.id);
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    });
  });
});
